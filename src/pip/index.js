/**
 * @file In order to load huge volumes of polygon data into memory without
 * breaking Node (due to its low heap-size limits), the package forks a
 * worker process per polygon layer/shapefile. This module contains
 * functions for initializing them and searching them.
 */

'use strict';

const path = require('path');
const childProcess = require( 'child_process' );
const logger = require( 'pelias-logger' ).get( 'wof-pip-service:master' );
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

let requestCount = 0;
// worker processes keyed on layer
const workers = {};

const responseQueue = {};
const wofData = {};

const defaultLayers = [
  'neighbourhood',
  'borough',
  'locality',
  'localadmin',
  'county',
  'macrocounty',
  'macroregion',
  'region',
  'dependency',
  'country',
  'marinearea',
  'ocean'
];

module.exports.create = function createPIPService(datapath, layers, localizedAdminNames, callback) {
  // take the intersection to keep order in decreasing granularity
  // ie - _.intersection([1, 2, 3], [3, 1]) === [1, 3]
  layers = _.intersection(defaultLayers, _.isEmpty(layers) ? defaultLayers : layers);

  // load all workers
  async.forEach(layers, (layer, done) => {
      startWorker(datapath, layer, localizedAdminNames, function (err, worker) {
        workers[layer] = worker;
        done();
      });
    },
    function end() {
      logger.info('PIP Service Loading Completed!!!');

      callback(null, {
        end: killAllWorkers,
        lookup: function (latitude, longitude, search_layers, responseCallback) {
          if (search_layers === undefined) {
            search_layers = layers;
          } else {
            // take the intersection of the valid layers and the layers sent in
            // so that if any layers are manually disabled for development
            // everything still works. this also means invalid layers
            // are silently ignored
            search_layers = _.intersection(layers, search_layers);
          }

          const id = requestCount++;

          if (search_layers.length === 0) {
            return responseCallback(null, []);
          }

          if (responseQueue.hasOwnProperty(id)) {
            const msg = `Tried to create responseQueue item with id ${id} that is already present`;
            logger.error(msg);
            return responseCallback(null, []);
          }

          // bookkeeping object that tracks the progress of the request
          responseQueue[id] = {
            results: [],
            latLon: {latitude: latitude, longitude: longitude},
            // copy of layers to search
            search_layers: search_layers.slice(),
            responseCallback: responseCallback
          };

          // call the worker for the first layer
          searchWorker(
            id,
            workers[responseQueue[id].search_layers.shift()],
            responseQueue[id].latLon);

        }
      });
    }
  );
};

function killAllWorkers() {
  Object.keys(workers).forEach(function (layer) {
    workers[layer].kill();
  });
}

function startWorker(datapath, layer, localizedAdminNames, callback) {
  const worker = childProcess.fork(path.join(__dirname, 'worker'));

  worker.on('message', msg => {
    if (msg.type === 'loaded') {
      const layerSpecificWofData = JSON.parse(fs.readFileSync(`wof-${layer}-data.json`));
      fs.unlinkSync(`wof-${layer}-data.json`);

      logger.info(`${msg.layer} worker loaded ${_.size(layerSpecificWofData)} features in ${msg.seconds} seconds`);

      // add all layer-specific WOF data to the big WOF data
      _.assign(wofData, layerSpecificWofData);
      callback(null, worker);
    }

    if (msg.type === 'results') {
      handleResults(msg);
    }
  });

  worker.send({
    type: 'load',
    layer: layer,
    datapath: datapath,
    localizedAdminNames: localizedAdminNames
  });
}

function searchWorker(id, worker, coords) {
  worker.send({
    type: 'search',
    id: id,
    coords: coords
  });
}

function handleResults(msg) {
  // logger.info('RESULTS:', JSON.stringify(msg, null, 2));

  if (!responseQueue.hasOwnProperty(msg.id)) {
    logger.error(`tried to handle results for missing id ${msg.id}`);
    return;
  }

  // console.log(JSON.stringify(msg.results));

  // first, handle the case where there was a miss
  if (_.isEmpty(msg.results)) {
    if (!_.isEmpty(responseQueue[msg.id].search_layers)) {
      // if there are no results, then call the next layer but only if there are more layer to call
      searchWorker(msg.id, workers[responseQueue[msg.id].search_layers.shift()], responseQueue[msg.id].latLon);
    } else {
      // no layers left to search, so return an empty array
      responseQueue[msg.id].responseCallback(null, []);
    }

  } else {
    // there was a hit, so find the hierachy and assemble all the pieces
    const hierarchy = wofData[msg.results.Id].Hierarchy;

    if (!_.isEmpty(hierarchy)) {
      const results = _.compact(_.values(hierarchy[0]).map(id => wofData[id]));

      responseQueue[msg.id].responseCallback(null, results);

    } else {
      // some records like oceans and marine areas don't have hierarchies, so use the raw WOF record
      responseQueue[msg.id].responseCallback(null, [wofData[msg.results.Id]]);

    }

    delete responseQueue[msg.id];
  }

}
