var util = require('util');
var _ = require('lodash');
var debug = require('debug')('skydns');
var etcd = require('../lib/etcd.js');
var backendMixin = require('../lib/backendMixin.js');

var dns = require('native-dns');
var util = require('util');


/**
 * Create a new Skydns backend
 * @constructor
 */
function BuiltInDns(docker) {
  if(! this instanceof BuiltInDns) return new BuiltInDns(docker);

  process.env.BUILTIN_DNS_PROXY = process.env.BUILTIN_DNS_PROXY || '8.8.8.8';

  this.name = "DNS";
  this.prefix = process.env.ETCD_PREFIX || '/dockerdns';
  this.domain = this.prefix.substr(1);
  this.cidCache = {};
  this.docker = docker;
  this.debug = debug;
  this.etcd = etcd;
  this.removeDepthWhenEmpty = 1;

  this.docker.on('newService', this.addService.bind(this));
  this.docker.on('die', this.removeServiceByCid.bind(this));

  console.log('DNS etcd path: ' + this.prefix);
  this.startServer(dns.createServer());
  this.startServer(dns.createTCPServer());
}
_.merge(BuiltInDns.prototype, backendMixin);


BuiltInDns.prototype._addService = function addService(url, val, cb) {
  etcd.set(url, JSON.stringify(val), cb);
};
/**
 * Add a DNS by service
 * @param {Object} service
 * @param cb
 */
BuiltInDns.prototype.addService = function addService(service, cb) {
  var self = this;
  // console.log('addService', arguments);
  var url = this._buildUrl(service);
  var imageUrl = this._buildImageUrl(service);

  var text = service.protocol;
  if(_.isArray(service.attribs.TAGS)) text += ',' + service.attribs.TAGS.join(',');

  var val = {
    host: service.ip,
    port: service.port,
    priority: service.attribs.SKYDNS_PRIORITY || 1,
    weight: service.attribs.SKYDNS_WEIGHT || 1,
    text: text
  };

  console.log('Service: ' + service.name + ' ' + service.ip + ':' + service.port + ' [' + url + ']');
  self._addService(url, val, function(err){
    self._addService(imageUrl, val, function(err2){
      if(err || err2) {
        if(cb) cb(err);
        return;
      }
      if(!self.cidCache[service.cid]) self.cidCache[service.cid] = [];
      self.cidCache[service.cid].push(url);
      if(cb) cb();
    });
  });
};


/**
 * Sync the etcd-services to the given
 * @param {Object} activeServices
 */
BuiltInDns.prototype.sync = function (activeServices) {
  var self = this;

  // console.log('sync', arguments);
  var runningMap = {};
  activeServices.forEach(function(service) {
     runningMap[self._buildUrl(service)] = service;
  });

  activeServices.forEach(function(service) {
     runningMap[self._buildImageUrl(service)] = service;
  });
  // Fetch current etcd-services
  etcd.get(this.prefix, {recursive: true}, function(err, obj) {
    if(err) {
      if (err.errorCode == 100) { // Key not found
        etcd.mkdir(self.prefix, function(err, res){
          if (err) {
            console.log(err);
          } else {
            self.sync(activeServices);
          }
        });
        return;
      }
      console.error('Error: etcd get ' + self.prefix);
      console.error(util.inspect(err, {showHidden: false, depth: 3}));
      return;
    }

    // recursive find keys beginning with our HOSTNAME
    var inEtcdUrls = [];
    if(obj.node.nodes) {
      inEtcdUrls = etcd.deepFindKeys(obj.node, new RegExp('/' + process.env.HOSTNAME + '-[^/]*'));
    }

    // remove not running
    var runningUrls = _.keys(runningMap);
    var toDelete = _.difference(inEtcdUrls, runningUrls);
    if(toDelete.length) {
      debug('Remove ' + toDelete.length + ' obsolete services');
      self.removeByUrls(toDelete);
    }

    // add not registred
    var toAdd = _.difference(runningUrls, inEtcdUrls);
    if(toAdd.length) {
      debug('Adding ' + toAdd.length + ' already running services');
      var added = {};
      toAdd.forEach(function(url) {
        if (added[runningMap[url].cid]) {
          return;
        }
        self.addService(runningMap[url], function(err) {
          if(err) return console.error('Error: Could add service ' + err.error.cause + ': ' + err.error.message);
        });
        added[runningMap[url].cid] = true;
      });
    }
  });

};


BuiltInDns.prototype._buildUrl = function _buildUrl(service) {
  return this.prefix + '/' + service.name + '/' + process.env.HOSTNAME;
};

BuiltInDns.prototype._buildImageUrl = function _buildImageUrl(service) {
  return this.prefix + '/' + service.imageName.replace(/\//g , '-') + '/' + process.env.HOSTNAME + '/' + service.name;
};


BuiltInDns.prototype._makeDNSRequest = function(name, type, cb) {
  if (typeof type == "function") {
    cb = type;
    type = 'A';
  }
  type = type || 'A';

  console.log('DNS Proxy', process.env.BUILTIN_DNS_PROXY, name, type);
  var question = dns.Question({
    name: name,
    type: type,
  });

  var start = Date.now();

  var req = dns.Request({
    question: question,
    server: { address: process.env.BUILTIN_DNS_PROXY, port: 53, type: 'udp' },
    timeout: 1000,
  });

  req.on('timeout', function () {
    console.error('Timeout in making request', name, process.env.BUILTIN_DNS_PROXY);
  });

  req.on('message', cb);

  req.on('end', function () {
    var delta = (Date.now()) - start;
    debug('Finished processing request: ' + delta.toString() + 'ms');
  });

  req.send();
};

var traverseObject = function(node) {
  var hits = [];
  var children = [];

  if(node.nodes && _.isArray(node.nodes)) {
    node.nodes.forEach(function(node) {
      children = children.concat(traverseObject(node));
    });
  }

  var uniqueChildren = children.reduce(function(prev, curr){
    if (prev.indexOf(curr.value.host) < 0) {
      prev.push(curr);
    }
    return prev;
  }, []);

  if (!node.value) {
    for (var i=0; i<uniqueChildren.length; i++) {
      if (uniqueChildren[i].value) {
        hits.push({
          key: node.key,
          value: uniqueChildren[i].value
        })
      }
    }
  } else {
    if (node.value && typeof node.value == 'string') {
      node.value = JSON.parse(node.value);
    }
    hits.push(node);
  }

  hits = hits.concat(children);
  return hits;
};

var nameToEtcdPath = function(domain, name) {
  return name.replace(domain, '').replace('*.', '').split('.').reverse().join('/');
};

var pathToNames = function(domain, path) {
  if (path == '/' + domain) {
    return [];
  }
  var parts = path.replace('/' + domain + '/', '').split('/').reverse();
  var name = parts.join('.') + '.' + domain;
  return [ name ];
};

BuiltInDns.prototype.startServer = function(server) {
  var self = this;

  server.on('request', function (request, response) {
    var q = request.question[0];

    console.log('DNS request', q.name);

    if ((q.name.indexOf(self.domain) > -1) && q.name.indexOf(self.domain) + self.domain.length == q.name.length) {
      var wildcard = q.name.indexOf('*.') > -1;

      var path = nameToEtcdPath(self.domain, q.name);
      console.log('Etcd get', self.prefix + path);
      etcd.get(self.prefix + path, {recursive: true}, function(err, obj) {
        if (err) {
          console.error(err);
          return response.send();
        }

        var added = {};
        traverseObject(obj.node).forEach(function(node){
          pathToNames(self.domain, node.key).forEach(function(name){
            if (!wildcard) {
              if (name !== q.name) {
                return;
              }
            }
            var key = name + node.value.host;
            if (added[key]) {
              return;
            }
            response.answer.push(dns.A({
              name: name,
              address: node.value.host,
              ttl: 600
            }));
            added[key] = true;
          });
        });
        console.log('DNS response', response.answer.map(function(a){ return [a.name, a.address] }));
        try {
          response.send();
        } catch(e) {
          // hack around broken dns-packet truncation
          response.answer = response.answer.length ? [ response.answer[0] ] : [];
          try {
            response.send();
          } catch(e) {
            console.error(e)
          }
        }
      });
    } else {
      console.log('FORWARD', q);
      self._makeDNSRequest(q.name, q.type, function(err, resp){
        if (err) {
          console.error(err);
        }

        if (resp.answer) {
          response.answer = resp.answer;
          response.authority = resp.authority;
          response.additional = resp.additional;
        }
        response.send();
      });
    }
  });

  server.on('error', function (err, buff, req, res) {
    console.log(err.stack);
  });

  var port = process.env.BUILTIN_DNS_PORT || 53;
  server.serve(port);
  console.log('DNS server listening on port', port);
};

process.on('uncaughtException', function(err) {
  console.error('uncaughtException', err.stack);
});


module.exports = BuiltInDns;
