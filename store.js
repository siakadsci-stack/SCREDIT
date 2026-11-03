/* S crédits : stockage local (IndexedDB).
   Interface de type « base de documents » : doc(chemin), collection(chemin),
   get / set / delete / onSnapshot. Toutes les données restent sur l'appareil.
   Pour passer plus tard à un vrai serveur (Firebase par exemple), il suffit de
   remplacer ce fichier : app.js n'utilise que cette interface. */
(function () {
  'use strict';

  var DB_NAME = 'scredits';
  var STORE = 'docs';
  var META = { fromCache: false, hasPendingWrites: false };
  var persistent = true;
  var backend = null;
  var listeners = [];
  var chan = null;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* Secours en mémoire si le navigateur interdit IndexedDB (navigation privée, par exemple) */
  function memoryBackend() {
    var m = new Map();
    return {
      get: function (k) { return Promise.resolve(m.has(k) ? m.get(k) : undefined); },
      put: function (k, v) { m.set(k, v); return Promise.resolve(); },
      del: function (k) { m.delete(k); return Promise.resolve(); },
      keys: function (prefix) {
        return Promise.resolve(Array.from(m.keys()).filter(function (k) { return k.indexOf(prefix) === 0; }));
      }
    };
  }

  function idbBackend(db) {
    function write(fn) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    }
    return {
      get: function (k) { return reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(k)); },
      put: function (k, v) { return write(function (s) { s.put(v, k); }); },
      del: function (k) { return write(function (s) { s.delete(k); }); },
      keys: function (prefix) {
        return reqP(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')));
      }
    };
  }

  function openBackend() {
    if (backend) return backend;
    backend = new Promise(function (resolve) {
      function fallback() { persistent = false; resolve(memoryBackend()); }
      if (!window.indexedDB) { fallback(); return; }
      var r;
      try { r = indexedDB.open(DB_NAME, 1); } catch (e) { fallback(); return; }
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { resolve(idbBackend(r.result)); };
      r.onerror = r.onblocked = fallback;
    });
    return backend;
  }

  /* Synchronisation entre onglets ouverts */
  try {
    chan = new BroadcastChannel('scredits');
    chan.onmessage = function (e) { notify(e.data, true); };
  } catch (e) { chan = null; }

  function parentOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
  function notify(path, remote) {
    if (!remote && chan) { try { chan.postMessage(path); } catch (e) { /* ignoré */ } }
    listeners.slice().forEach(function (l) {
      if ((l.kind === 'doc' && l.path === path) || (l.kind === 'col' && l.path === parentOf(path))) l.fire();
    });
  }

  function listen(kind, path, emit, error) {
    var active = true, seq = 0;
    var l = {
      kind: kind, path: path,
      fire: function () {
        var mine = ++seq;
        emit().then(function (deliver) {
          if (active && mine === seq) deliver();
        }, function (e) {
          if (active && error) error({ code: 'unavailable', message: String((e && e.message) || e) });
        });
      }
    };
    listeners.push(l);
    l.fire();
    return function () {
      active = false;
      var i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function snapOf(id, v) {
    return {
      id: id,
      exists: v !== undefined,
      data: function () { return v === undefined ? undefined : clone(v); },
      metadata: META
    };
  }

  function docRef(path) {
    var id = path.slice(path.lastIndexOf('/') + 1);
    return {
      id: id,
      path: path,
      get: function () {
        return openBackend().then(function (b) { return b.get(path); }).then(function (v) { return snapOf(id, v); });
      },
      set: function (data) {
        var v = clone(data);
        return openBackend().then(function (b) { return b.put(path, v); }).then(function () { notify(path); });
      },
      delete: function () {
        return openBackend().then(function (b) { return b.del(path); }).then(function () { notify(path); });
      },
      collection: function (name) { return colRef(path + '/' + name); },
      onSnapshot: function (next, error) {
        return listen('doc', path, function () {
          return openBackend().then(function (b) { return b.get(path); }).then(function (v) {
            return function () { next(snapOf(id, v)); };
          });
        }, error);
      }
    };
  }

  function colRef(path) {
    return {
      path: path,
      doc: function (id) { return docRef(path + '/' + (id || newId())); },
      onSnapshot: function (next, error) {
        return listen('col', path, function () {
          var prefix = path + '/';
          return openBackend().then(function (b) {
            return b.keys(prefix).then(function (keys) {
              var direct = keys.filter(function (k) { return k.indexOf('/', prefix.length) === -1; });
              return Promise.all(direct.map(function (k) {
                return b.get(k).then(function (v) { return snapOf(k.slice(prefix.length), v); });
              }));
            });
          }).then(function (docs) {
            return function () { next({ docs: docs, size: docs.length, empty: docs.length === 0, metadata: META }); };
          });
        }, error);
      }
    };
  }

  var user = {
    id: function () { return Promise.resolve('local'); },
    isOwner: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); }
  };
  var db = {
    doc: function (p) { return docRef(p); },
    collection: function (p) { return colRef(p); }
  };

  window.SCreditsStore = {
    use: function (name) { return Promise.resolve(name === 'user' ? user : name === 'db' ? db : null); },
    get persistent() { return persistent; }
  };

  openBackend();
  /* Demande au navigateur de ne pas effacer les données automatiquement */
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* ignoré */ }
})();
