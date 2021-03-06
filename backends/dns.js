var util = require('util');
var _ = require('lodash');
var debug = require('debug')('dns');
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

var findUrlsByCid = function(node, cid) {
  var hits = [];
  if(node.value && node.value.indexOf(cid) > -1) {
    hits.push(node.key);
    return hits;
  }
  if(node.nodes && _.isArray(node.nodes)) {
    node.nodes.forEach(function(node) {
      hits = hits.concat(findUrlsByCid(node, cid));
    });
  }
  return hits;
};

BuiltInDns.prototype.removeServiceByCid = function (cid) {
  var self = this;
  this.etcd.get(this.prefix, {recursive: true}, function(err, obj) {
    if(err) return cb(err);
    if(!obj.node.nodes) return;

    var urls = findUrlsByCid(obj.node, cid);
    console.log('Urls to remove:', urls);
    self.removeByUrls(urls);
  });
};

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
    cid: service.cid,
    text: text
  };

  console.log('Service: ' + service.name + ' ' + service.ip + (service.port  ? ':' + service.port : '') + ' [' + url + ']');
  self._addService(url, val, function(err){
    self._addService(imageUrl, val, function(err2){
      if(err || err2) {
        console.log(err, err2);
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

    var inEtcdUrls = [];
    if (obj.node.nodes) {
      inEtcdUrls = etcd.deepFindKeys(obj.node, new RegExp('\/' + process.env.HOSTNAME + '$'));
    }
    console.log('inEtcdUrls', inEtcdUrls);

    // remove not running
    var runningUrls = _.keys(runningMap);

    console.log('runningUrls', runningUrls);
    var toDelete = _.difference(inEtcdUrls, runningUrls);
    if(toDelete.length) {
      debug('Remove ' + toDelete.length + ' obsolete services');
      self.removeByUrls(toDelete);
    }

    // add not registred
    // var toAdd = _.difference(runningUrls, inEtcdUrls);
    var toAdd = runningUrls; // need to update everything in case of rename
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
  return this.prefix + '/' + service.imageName.replace(/\/|:/g, '-') + '/' + service.name + '/' + process.env.HOSTNAME;
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

var cache = {};
var proxyTimeout = 5*60*1000;
var localTimeout = 3*1000;

BuiltInDns.prototype.startServer = function(server) {
  var self = this;

  server.on('request', function (request, response) {
    var q = request.question[0];

    console.log('DNS request', q.name);
    var isDockerHost = (q.name.indexOf(self.domain) > -1) && q.name.indexOf(self.domain) + self.domain.length == q.name.length;

    // check in cache
    var cacheKey = [q.name, q.type].join('-');
    var cached = cache[cacheKey];
    if (cached) {
      var timeout = isDockerHost ? localTimeout : proxyTimeout;

      if (+(new Date) - cached.timestamp > timeout)  {
        delete cache[cacheKey];
      } else {
        for (var key in cached.value) {
          response[key] = cached.value[key];
        }
        console.log('DNS response from cache', response.answer.map(function(a){ return [a.name, a.address] }));
        return response.send();
      }
    }

    if (isDockerHost) {
      var wildcard = q.name.indexOf('*.') > -1;
      var name = q.name;
      var parts = q.name.split('.');
      if (parts.length > 2) {
        var first = parts.shift();
        if (first == '*') {
          first = '';
        }
        var regex = new RegExp(first + '.*' + parts.join('\\.'));
        name = parts.slice(parts.length - 2).join('.');
      }

      var path = nameToEtcdPath(self.domain, name);
      console.log('Etcd get', self.prefix + path);
      etcd.get(self.prefix + path, {recursive: true}, function(err, obj) {
        if (err) {
          console.error(err);
          return response.send();
        }

        var added = {};
        traverseObject(obj.node).forEach(function(node){
          pathToNames(self.domain, node.key).forEach(function(name){
            if (regex) {
              if (!name.match(regex)) {
                return;
              }
            } else if (!wildcard) {
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
        cache[cacheKey] = {
          timestamp: +(new Date),
          value: {
            answer: response.answer
          }
        };
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
      console.log('Forwarding DNS query', q);
      self._makeDNSRequest(q.name, q.type, function(err, resp){
        if (err) {
          console.error(err);
        }

        if (resp.answer) {
          response.answer = resp.answer;
          response.authority = resp.authority;
          response.additional = resp.additional;
          cache[cacheKey] = {
            timestamp: +(new Date),
            value: {
              answer: resp.answer,
              authority: resp.authority,
              additional: resp.additional
            }
          };
        }
        console.log('DNS response', response.answer.map(function(a){ return [a.name, a.address] }));
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
