#!/usr/bin/env node
var path        = require('path');
var Promise     = require('promise');
var debug       = require('debug')('index:bin:server');
var raven       = require('raven');
var base        = require('taskcluster-base');
var taskcluster = require('taskcluster-client');
var data        = require('./data');
var Handlers    = require('./handlers');
var v1          = require('./api');
var loader      = require('taskcluster-lib-loader');

// Create component loader
var load = loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => base.config({profile}),
  },

  // Configure IndexedTask and Namespace entities
  IndexedTask: {
    requires: ['cfg'],
    setup: ({cfg}) => data.IndexedTask.setup({
      account:          cfg.app.azureAccount,
      table:            cfg.app.indexedTaskTableName,
      credentials:      cfg.taskcluster.credentials,
      authBaseUrl:      cfg.taskcluster.authBaseUrl
    })
  },
  Namespace: {
    requires: ['cfg'],
    setup: ({cfg}) => data.Namespace.setup({
      account:          cfg.app.azureAccount,
      table:            cfg.app.namespaceTableName,
      credentials:      cfg.taskcluster.credentials,
      authBaseUrl:      cfg.taskcluster.authBaseUrl
    })
  },

  // Create a validator
  validator: {
    requires: ['cfg'],
    setup: ({cfg}) => base.validator({
      prefix: 'index/v1/',
      aws:    cfg.aws
    })
  },

  // Create InfluxDB connection for submitting statistics
  drain: {
    requires: ['cfg'],
    setup: ({cfg}) => {
      if (cfg.influx && cfg.influx.connectionString) {
        return new base.stats.Influx(cfg.influx)
      }
      return new base.stats.NullDrain();
    }
  },

  // Configure queue and queueEvents
  queue: {
    requires: ['cfg'],
    setup: ({cfg}) => new taskcluster.Queue({
      credentials: cfg.taskcluster.credentials
    })
  },

  queueEvents: {
    requires: [],
    setup: () => new taskcluster.QueueEvents()
  },

  // Start monitoring the process
  monitor: {
    requires: ['cfg', 'drain'],
    setup: ({cfg, drain}) => base.stats.startProcessUsageReporting({
      drain:      drain,
      component:  cfg.app.statsComponent,
      process:    'server'
    })
  },

  raven: {
    requires: ['cfg'],
    setup: ({cfg}) => {
      if (cfg.raven.sentryDSN) {
        return new raven.Client(cfg.raven.sentryDSN);
      }
      return null;
    }
  },

  api: {
    requires: ['cfg', 'validator', 'IndexedTask', 'Namespace', 'drain', 'queue', 'raven'],
    setup: async ({cfg, validator, IndexedTask, Namespace, drain, queue, raven}) => v1.setup({
      context: {
        queue,
        validator,
        IndexedTask,
        Namespace
      },
      authBaseUrl:      cfg.taskcluster.authBaseUrl,
      publish:          cfg.app.publishMetaData,
      baseUrl:          cfg.server.publicUrl + '/v1',
      referencePrefix:  'index/v1/api.json',
      aws:              cfg.aws,
      component:        cfg.app.statsComponent,
      validator,
      drain,
      raven
    })
  },

  server: {
    requires: ['cfg', 'api'],
    setup: async ({cfg, api}) => {
      // Create app
      let app = base.app(cfg.server);

      // Mount API router
      app.use('/v1', api);

      // Create server
      return app.createServer();
    }
  },

  handlers: {
    requires: ['IndexedTask', 'Namespace', 'queue', 'queueEvents', 'cfg', 'drain'],
    setup: async ({IndexedTask, Namespace, queue, queueEvents, cfg, drain}) => {
      var handlers = new Handlers({
        IndexedTask:        IndexedTask,
        Namespace:          Namespace,
        queue:              queue,
        queueEvents:        queueEvents,
        credentials:        cfg.pulse,
        queueName:          cfg.app.listenerQueueName,
        routePrefix:        cfg.app.routePrefix,
        drain:              drain,
        component:          cfg.app.statsComponent
      });

      // Start listening for events and handle them
      return handlers.setup();
    }
  },
}, ['profile']);

// If server.js is executed start the server
if (!module.parent) {
  load(process.argv[2], {
    process: process.argv[2],
    profile: process.env.NODE_ENV,
  }).catch(err => {
    console.log(err.stack);
    process.exit(1);
  });
}

// Export load for tests
module.exports = load;
