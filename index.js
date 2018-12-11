var fs = require('fs');
var path = require('path');
var Chain = require('traverse-chain');

var fss = {};

/**
 *  Error handler wrapper.
 */
fss.errorHandler = function(err) {
  if (err) {
    if (module.exports.__errorHandler) {
      module.exports.__errorHandler(err);
    } else {
      throw err;
    }
  }
};

fss.fileSystem = fs;

var error = {
  notExist: function(name) {
    return new Error(name + ' does not exist.');
  }
};

var objType = function(type) {
  return function(input) {
    return ({}).toString.call(input) === '[object ' + type +  ']';
  }
}

var isString = objType('String');
var isRegexp = objType('RegExp');
var isFunc = objType('Function');

/**
 * Check pattern against the path
 */
var compare = function(pat, name) {
  var str = path.basename(name);
  return (
    isRegexp(pat) && pat.test(name)
    || isString(pat) && pat === str
  );
};

var createInstance = function(fileSystem, errHandler) {

  var internalApi = {}; 
  internalApi.fileSystem = fileSystem || fss.fileSystem;
  internalApi.errHandler = errHandler || fss.errorHandler;

  function existed(name) {
    return internalApi.fileSystem.existsSync(name)
  }
  function fsType(type) {
    return function(name) {
      try {
        return internalApi.fileSystem.lstatSync(name)['is' + type]()
      } catch(e) {
        internalApi.errHandler(e);
      }
    }
  }  

  ['readdir', 'lstat'].forEach(function(method) {
    var origin = internalApi.fileSystem[method];
    internalApi[method] = function(path, callback) {
      return origin.apply(internalApi.fileSystem, [path, function(err) {
        internalApi.errHandler(err);
        return callback.apply(null, arguments);
      }]);
    }
  });

  var publicApi = {
    existed:      existed,
    file:         fsType('File'),
    directory:    fsType('Directory'),
    symbolicLink: fsType('SymbolicLink')         
  };

  /**
  * Enhancement for fs.readlink && fs.readlinkSync.
  */
 internalApi.readlink = function(name, fn, depth) {
    if (depth == undefined) depth = 5;
    if (!publicApi.existed(name) && (depth < 5)) {
      return fn(path.resolve(name));
    }
    var isSymbolicLink = publicApi.symbolicLink(name);
    if (!isSymbolicLink) {
      fn(path.resolve(name));
    } else if (depth) {
      internalApi.fileSystem.realpath(name, function(err, origin) {
        if (err && /(ENOENT|ELOOP)/.test(err.code)) {
          fn(name);
        } else {
          internalApi.errHandler(err);
          internalApi.readlink(origin, fn, --depth);
        }
      });
    } else {
      fn(isSymbolicLink ? '' : path.resolve(name));
    }
  }  

  internalApi.readlinkSync = function(name, depth) {
    if (depth == undefined) depth = 5;
    if (!publicApi.existed(name) && depth < 5) {
      return path.resolve(name);
    }
    var isSymbolicLink = publicApi.symbolicLink(name);
    if (!isSymbolicLink) {
      return path.resolve(name);
    } else if (depth) {
      var origin;
      try {
        origin = internalApi.fileSystem.realpathSync(name);
      } catch (err) {
        if (/(ENOENT|ELOOP)/.test(err.code)) return name;
        else internalApi.errHandler(err);
      }
      return internalApi.readlinkSync(origin, --depth);
    } else {
      return isSymbolicLink ? '' : path.resolve(name);
    }
  }

    /**
   * Traverse a directory recursively.
   *
   * @param {String} root
   * @param {String} type
   * @param {Function} action
   * @return {Array} the result
   * @api private
   */
  internalApi.traverseSync = function(root, type, action) {
    if (!publicApi.existed(root)) throw error.notExist(root);
    var originRoot = root;
    if (publicApi.symbolicLink(root)) {
      root = internalApi.readlinkSync(root);
    }
    if (publicApi.directory(root)) {
      internalApi.fileSystem.readdirSync(root).forEach(function(dir) {
        dir = path.join(originRoot, dir);
        var handleDir = function(skip) {
          if (type == 'dir') action(dir);
          if (skip) return;
          internalApi.traverseSync(dir, type, action);
        }
        var handleFile = function() {
          if (type == 'file') action(dir);
        }
        var isSymbolicLink = publicApi.symbolicLink(dir);
        if (publicApi.directory(dir)) {
          handleDir();
        } else if (isSymbolicLink) {
          var origin = internalApi.readlinkSync(dir);
          if (origin) {
            if (publicApi.existed(origin) && publicApi.directory(origin)) {
              handleDir(isSymbolicLink);
            } else {
              handleFile();
            }
          }
        } else {
          handleFile();
        }
      });
    }
  }

    /**
   * Traverse a directory recursively and asynchronously.
   *
   * @param {String} root
   * @param {String} type
   * @param {Function} action
   * @param {Function} callback
   * @param {Chain} c
   * @param {Object}
   * @api private
   */
  internalApi.traverseAsync = function(root, type, action, callback, c) {
    if (!publicApi.existed(root)) {
      internalApi.errHandler(error.notExist(root))
    }

    var originRoot = root;
    if (publicApi.symbolicLink(root)) {
      root = internalApi.readlinkSync(root);
    }

    if (publicApi.directory(root)) {
      internalApi.readdir(root, function(err, all) {
        var chain = Chain();
        all && all.forEach(function(dir) {
          dir = path.join(originRoot, dir);
          chain.add(function() {
            var handleFile = function() {
              if (type == 'file') action(dir);
              process.nextTick(function() { chain.next() });
            }
            var handleDir = function(skip) {
              if (type == 'dir') action(dir);
              if (skip) chain.next();
              else process.nextTick(function() { internalApi.traverseAsync(dir, type, action, callback, chain)});
            }
            var isSymbolicLink = publicApi.symbolicLink(dir);
            if (publicApi.directory(dir)) {
              handleDir();
            } else if (isSymbolicLink) {
              internalApi.readlink(dir, function(origin) {
                if (origin) {
                  if (publicApi.existed(origin) && publicApi.directory(origin)) {
                    handleDir(isSymbolicLink)
                  } else {
                    handleFile()
                  }
                } else {
                  chain.next();
                }
              });
            } else {
              handleFile();
            }
          })
        });
        chain.traverse(function() {
          c ? c.next() : callback();
        });
      });
    }
  };


  ['file', 'dir'].forEach(function(type) {

    /**
     * `find.file` and `find.dir`
     *
     * Find files or sub-directories in a given directory and
     * passes the result in an array as a whole. This follows
     * the default callback style of nodejs, think about `fs.readdir`,
     *
     * @param {RegExp|String} pat
     * @param {String} root
     * @param {Function} fn
     * @api public
     */
    publicApi[type] = function(pat, root, fn) {
      var buffer = [];
      if (arguments.length == 2) {
        fn = root;
        root = pat;
        pat = '';
      }
      process.nextTick(function() {
        internalApi.traverseAsync(
          root
        , type
        , function(n) { buffer.push(n);}
        , function() {
            if (isFunc(fn) && pat) {
              fn(buffer.filter(function(n) {
                return compare(pat, n);
              }));
            } else {
              fn(buffer);
            }
          }
        );
      });
      return {
        error: function(handler) {
          if (isFunc(handler)) {
            module.exports.__errorHandler = handler;
          }
        }
      }
    }

  /**
   * `fileSync` and `dirSync`
   *
   * Find files or sub-directories in a given directory synchronously
   * and returns the result as an array. This follows the default 'Sync'
   * methods of nodejs, think about `fs.readdirSync`,
   *
   * @param {RegExp|String} pat
   * @param {String} root   
   * @return {Array} the result
   * @api public
   */
  publicApi[type + 'Sync'] = function(pat, root) {
    var buffer = [];
    if (arguments.length == 1) {
      root = pat;
      pat = '';
    }
    internalApi.traverseSync(root, type, function(n) {
      buffer.push(n);
    });
    return pat && buffer.filter(function(n) {
      return compare(pat, n);
    }) || buffer;
  }

    
  /**
   * `eachfile` and `eachdir`
   *
   * Find files or sub-directories in a given directory and
   * apply with a given action to each result immediately
   * rather than pass them back as an array.
   *
   * @param {RegExp|String} pat
   * @param {String} root
   * @param {Function} action
   * @return {Object} for chain methods
   * @api public
   *
   */
  publicApi['each' + type] = function(pat, root, action) {
    var callback = function() {}
    if (arguments.length == 2) {
      action = root;
      root = pat;
      pat = '';
    }
    process.nextTick(function() {
      internalApi.traverseAsync(
          root
        , type
        , function(n) {
            if (!isFunc(action)) return;
            if (!pat || compare(pat, n)) {
              action(n);
            }
          }
        , callback
      );
    });
    return {
      end: function(fn) {
        if (isFunc(fn)) {
          callback = fn;
        }
        return this;
      },
      error: function(handler) {
        if (isFunc(handler)) {
          module.exports.__errorHandler = handler;
        }
        return this;
      }
    };
  }
});  

  return publicApi;
};


var defaultInstance = createInstance();
defaultInstance.in = createInstance;

/**
 * Outline the APIs.
 */
 module.exports = defaultInstance;

// module exports set to object that looks like:
//{
   // file:      function([pat,] root, callback) {}
   // dir:       function([pat,] root, callback) {}
   // eachfile:  function([pat,] root, action) {}
   // eachdir:   function([pat,] root, action) {}
   // fileSync:  function([pat,] root) {}
   // dirSync:   function([pat,] root) {}
   // in:        function([fs, errHandler]) {}
//};
// in is a factory method that creates a new instance of find api, pointing at a specified fs.