/* S crédits : logique de l'application (crédits, versements, alertes, licence, administrateur). */
(function () {
  var KEY = 'carnet-credits-v1';
  var credits = [];
  var col = null;
  var mode = 'pending';
  var loaded = false;
  var loadError = false;
  var slow = false;
  var filter = 'all';
  var query = '';
  var openIds = {};
  var confirmDel = null;
  var alerted = {};
  var lastDay = '';

  function $(s) { return document.querySelector(s); }
  var nfmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
  function nf(n) { return nfmt.format(n); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayIso() { return iso(new Date()); }
  function parseIso(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 86400000); }
  function fmtDate(s) { return parseIso(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function round2(x) { return Math.round(x * 100) / 100; }
  function paid(c) { return round2(c.versements.reduce(function (s, v) { return s + v.montant; }, 0)); }
  function reste(c) { return Math.max(0, round2(c.total - paid(c))); }
  function isDue(c) { return reste(c) > 0 && c.rappel <= todayIso(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function status(c) {
    if (reste(c) <= 0) return { k: 'good', t: 'Soldé' };
    var d = daysBetween(todayIso(), c.rappel);
    if (d < 0) return { k: 'bad', t: 'En retard de ' + (-d) + (d === -1 ? ' jour' : ' jours') };
    if (d === 0) return { k: 'warn', t: "À encaisser aujourd'hui" };
    return { k: 'info', t: 'Rappel dans ' + d + (d === 1 ? ' jour' : ' jours') };
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* Enregistrement */
  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(credits)); return true; }
    catch (e) { toast("Enregistrement impossible sur cet appareil."); return false; }
  }
  function loadLocal() {
    try { var raw = localStorage.getItem(KEY); credits = raw ? JSON.parse(raw) : []; }
    catch (e) { credits = []; }
  }
  var queue = Promise.resolve();
  function enqueue(fn) {
    queue = queue.then(fn).catch(function () { toast("L'enregistrement a échoué. Vérifiez votre connexion et réessayez."); });
  }
  function commit(c) {
    var i = credits.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) credits[i] = c; else credits.push(c);
    if (col) { var copy = clone(c); enqueue(function () { return col.doc(copy.id).set(copy); }); }
    else saveLocal();
    render();
    checkDue();
  }
  function drop(id) {
    credits = credits.filter(function (x) { return x.id !== id; });
    if (col) enqueue(function () { return col.doc(id).delete(); });
    else saveLocal();
    render();
  }
  function normalize(c) {
    c.versements = Array.isArray(c.versements) ? c.versements : [];
    c.total = Number(c.total) || 0;
    c.pieces = c.pieces || { recto: false, verso: false };
    return c;
  }

  /* Rendu */
  function renderSummary() {
    var tot = 0, enc = 0, rst = 0, due = 0;
    credits.forEach(function (c) { tot += c.total; enc += paid(c); rst += reste(c); if (isDue(c)) due++; });
    $('#summary').innerHTML =
      '<div class="sum-main"><span class="lbl">Reste à encaisser</span><span class="big">' + nf(round2(rst)) + '<small>FCFA</small></span></div>' +
      '<dl class="sum-side">' +
      '<div><dt>Total des crédits</dt><dd>' + nf(round2(tot)) + '</dd></div>' +
      '<div><dt>Déjà encaissé</dt><dd>' + nf(round2(enc)) + '</dd></div>' +
      '<div><dt>Clients à relancer</dt><dd class="' + (due ? 'bad' : '') + '">' + due + '</dd></div>' +
      '</dl>';
  }

  function renderAlerts() {
    var box = $('#alerts');
    var dues = credits.filter(isDue).sort(function (a, b) { return a.rappel < b.rappel ? -1 : 1; });
    if (!dues.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<h2>À encaisser maintenant</h2><ul>' + dues.map(function (c) {
      return '<li><span class="txt">Rappel : il faut encaisser <strong>' + esc(c.nom) + '</strong>, qui doit <strong class="num">' + nf(reste(c)) + ' FCFA</strong>.</span>' +
        '<span class="acts"><button class="btn btn-small" type="button" data-act="view" data-id="' + c.id + '">Voir le dossier</button>' +
        '<button class="btn btn-small" type="button" data-act="delay" data-id="' + c.id + '">Reporter de 7 jours</button></span></li>';
    }).join('') + '</ul>';
  }

  /* Pièces d'identité : photos réduites, stockées à part du dossier */
  var pieceCache = {};
  var pieceLoading = {};
  var SIDES = [['recto', 'Recto'], ['verso', 'Verso']];
  function compress(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('type')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, 1100 / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        var q = 0.75, out = cv.toDataURL('image/jpeg', q);
        while (out.length > 190000 && q > 0.35) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
        if (out.length > 190000) {
          cv.width = Math.round(w * 0.7); cv.height = Math.round(h * 0.7);
          ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
          out = cv.toDataURL('image/jpeg', 0.6);
        }
        resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('read')); };
      img.src = url;
    });
  }
  function pieceCol(id) { return col.doc(id).collection('pieces'); }
  async function pieceSave(id, side, data) {
    if (col) await pieceCol(id).doc(side).set({ img: data });
    else localStorage.setItem(KEY + '-p-' + id + '-' + side, data);
    pieceCache[id + ':' + side] = data;
  }
  async function pieceLoad(id, side) {
    var k = id + ':' + side;
    if (k in pieceCache) return pieceCache[k];
    var v = null;
    if (col) { var s = await pieceCol(id).doc(side).get(); v = s.exists ? (s.data().img || null) : null; }
    else { try { v = localStorage.getItem(KEY + '-p-' + id + '-' + side); } catch (e) { v = null; } }
    pieceCache[k] = v;
    return v;
  }
  async function pieceDelete(id, side) {
    if (col) await pieceCol(id).doc(side).delete();
    else { try { localStorage.removeItem(KEY + '-p-' + id + '-' + side); } catch (e) {} }
    pieceCache[id + ':' + side] = null;
  }
  function piecesHtml(c) {
    return SIDES.map(function (sd) {
      var side = sd[0], label = sd[1];
      var has = !!(c.pieces && c.pieces[side]);
      var k = c.id + ':' + side;
      var body;
      if (!has) body = '<p class="rappel">Aucune photo.</p>';
      else if (!(k in pieceCache)) body = '<p class="rappel">Chargement de la photo…</p>';
      else if (!pieceCache[k]) body = '<p class="rappel">Photo introuvable.</p>';
      else body = '<img class="piece-img" src="' + pieceCache[k] + '" alt="' + label + " de la pièce d'identité de " + esc(c.nom) + '" data-act="zoom">';
      return '<div class="piece"><h5>' + label + '</h5>' + body + '<div class="piece-acts">' +
        '<label class="btn btn-small file-btn">' + (has ? 'Remplacer' : 'Ajouter une photo') + '<input type="file" accept="image/*" hidden data-file="' + c.id + '|' + side + '"></label>' +
        (has ? '<button class="link link-danger" type="button" data-act="rmpiece" data-id="' + c.id + '" data-side="' + side + '">Retirer</button>' : '') +
        '</div></div>';
    }).join('');
  }
  function refreshPieces(id) {
    var el = document.getElementById('pc-' + id), c = find(id);
    if (el && c) el.innerHTML = piecesHtml(c);
  }
  function hydratePieces() {
    credits.forEach(function (c) {
      if (!openIds[c.id] || !c.pieces) return;
      SIDES.forEach(function (sd) {
        var side = sd[0], k = c.id + ':' + side;
        if (c.pieces[side] && !(k in pieceCache) && !pieceLoading[k]) {
          pieceLoading[k] = true;
          pieceLoad(c.id, side).catch(function () { pieceCache[k] = null; }).then(function () { pieceLoading[k] = false; refreshPieces(c.id); });
        }
      });
    });
  }

  function cardHtml(c) {
    var st = status(c), r = reste(c), p = paid(c);
    var pct = c.total > 0 ? Math.min(100, Math.round(p / c.total * 100)) : 0;
    var open = !!openIds[c.id];
    var hasPiece = c.pieces && (c.pieces.recto || c.pieces.verso);
    var sub = [c.tel, c.note].filter(Boolean).map(esc).concat(hasPiece ? ["Pièce d'identité jointe"] : []).join(' · ');
    var hist = c.versements.length
      ? '<ul class="hist">' + c.versements.map(function (v, i) {
          return '<li><span class="d">' + fmtDate(v.date) + (v.label ? ' · ' + esc(v.label) : '') + '</span><span class="num">' + nf(v.montant) + ' FCFA</span>' +
            '<button class="link link-danger" type="button" data-act="rmv" data-id="' + c.id + '" data-i="' + i + '">Retirer</button></li>';
        }).join('') + '</ul>'
      : '<p class="rappel" style="margin-top:6px">Aucun versement pour le moment.</p>';
    var del = confirmDel === c.id
      ? '<span>Supprimer ce crédit définitivement ?</span><button class="btn btn-small btn-danger" type="button" data-act="delyes" data-id="' + c.id + '">Oui, supprimer</button><button class="btn btn-small" type="button" data-act="delno" data-id="' + c.id + '">Annuler</button>'
      : '<button class="link link-danger" type="button" data-act="del" data-id="' + c.id + '">Supprimer ce crédit</button>';
    return '<article class="credit" id="c-' + c.id + '">' +
      '<div class="credit-head"><div><h3>' + esc(c.nom) + '</h3>' + (sub ? '<p class="sub">' + sub + '</p>' : '') + '</div><span class="pill ' + st.k + '">' + st.t + '</span></div>' +
      '<dl class="figures"><div><dt>Total dû</dt><dd>' + nf(c.total) + '</dd></div><div><dt>Versé</dt><dd>' + nf(p) + '</dd></div><div class="rest"><dt>Reste à payer</dt><dd>' + nf(r) + '</dd></div></dl>' +
      '<div class="bar" role="progressbar" aria-label="Part déjà payée" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
      (r > 0 ? '<p class="rappel">Rappel de recouvrement : <strong>' + fmtDate(c.rappel) + '</strong></p>' : '') +
      (r > 0 ? '<div class="pay"><input id="p-' + c.id + '" type="number" inputmode="decimal" min="0" step="any" placeholder="Montant reçu" aria-label="Montant du versement de ' + esc(c.nom) + '" data-pay="' + c.id + '">' +
        '<button class="btn btn-primary btn-small" type="button" data-act="pay" data-id="' + c.id + '">Enregistrer le versement</button>' +
        '<button class="btn btn-small" type="button" data-act="settle" data-id="' + c.id + '">Tout solder</button></div>' : '') +
      '<button class="link toggle" type="button" data-act="toggle" data-id="' + c.id + '" aria-expanded="' + open + '">' + (open ? 'Masquer les détails' : 'Historique et réglages') + '</button>' +
      '<div class="details"' + (open ? '' : ' hidden') + '>' +
        '<div><h4>Versements reçus</h4>' + hist + '</div>' +
        '<div><h4>Pièce d\'identité</h4><div class="pieces" id="pc-' + c.id + '">' + piecesHtml(c) + '</div></div>' +
        '<div class="row-edit"><label>Date de rappel<input id="rd-' + c.id + '" type="date" value="' + c.rappel + '"></label>' +
        '<button class="btn btn-small" type="button" data-act="setdate" data-id="' + c.id + '">Modifier la date</button>' +
        '<button class="btn btn-small" type="button" data-act="delay" data-id="' + c.id + '">Reporter de 7 jours</button></div>' +
        '<div class="danger">' + del + '</div>' +
      '</div></article>';
  }

  function renderList() {
    var box = $('#list');
    if (loadError) { box.innerHTML = '<div class="empty"><h3>Vos crédits sont momentanément inaccessibles</h3><p>Rechargez la page dans un instant. Vos données ne sont pas perdues.</p></div>'; return; }
    if (!loaded) { box.innerHTML = '<div class="empty"><p>Chargement de vos crédits…</p></div>'; return; }
    if (!credits.length) {
      box.innerHTML = '<div class="empty"><h3>Aucun crédit enregistré</h3><p>Ajoutez un client avec le montant dû, l\'avance reçue et la date à laquelle vous voulez être prévenu. Le jour venu, une alerte vous indique qui encaisser et combien.</p>' +
        '<div class="acts"><button class="btn btn-primary" type="button" data-act="newform">Ajouter mon premier crédit</button><button class="btn" type="button" data-act="sample">Voir un exemple</button></div></div>';
      return;
    }
    var q = query.trim().toLowerCase();
    var rows = credits.filter(function (c) {
      if (filter === 'due' && !isDue(c)) return false;
      if (filter === 'paid' && reste(c) > 0) return false;
      if (q && c.nom.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) {
      var ra = reste(a) > 0, rb = reste(b) > 0;
      if (ra !== rb) return ra ? -1 : 1;
      if (ra) return a.rappel < b.rappel ? -1 : a.rappel > b.rappel ? 1 : 0;
      return a.nom.localeCompare(b.nom, 'fr');
    });
    if (!rows.length) { box.innerHTML = '<div class="empty"><p>Aucun dossier ne correspond à ce filtre.</p></div>'; return; }
    box.innerHTML = rows.map(cardHtml).join('');
    hydratePieces();
  }

  function renderFoot() {
    var lines = [];
    if (mode === 'cloud') lines.push("Vos données sont enregistrées sur cet appareil, dans ce navigateur.");
    if (window.SCreditsStore && window.SCreditsStore.persistent === false) lines.push("Attention : ce navigateur n'enregistre pas durablement. Vos données seront perdues à la fermeture.");
    else if (mode === 'local') lines.push("Vos données sont enregistrées sur cet appareil seulement.");
    if (slow) lines.push("Connexion lente : les montants affichés peuvent ne pas être à jour.");
    lines.push("Les alertes s'affichent à l'ouverture de l'application et pendant qu'elle reste ouverte.");
    $('#foot').innerHTML = lines.map(function (l) { return '<p>' + l + '</p>'; }).join('');
  }

  function render() { renderSummary(); renderAlerts(); renderList(); renderFoot(); }

  /* Alerte à l'échéance */
  function showOverlay(dues) {
    var ov = $('#overlay');
    $('#dialog').innerHTML = '<h2 id="ovTitle">Rappel de recouvrement</h2><ul>' + dues.map(function (c) {
      return '<li>Il faut encaisser <strong>' + esc(c.nom) + '</strong> : il doit <strong class="num">' + nf(reste(c)) + ' FCFA</strong>.</li>';
    }).join('') + '</ul><div class="acts"><button class="btn" type="button" data-act="ovclose">Fermer</button><button class="btn btn-primary" type="button" data-act="ovview" id="ovMain">Voir les dossiers</button></div>';
    ov.hidden = false;
    var b = $('#ovMain'); if (b) b.focus();
  }
  function closeOverlay() { $('#overlay').hidden = true; }
  function checkDue() {
    if (!loaded || loadError || lstate !== 'ok') return;
    var dues = credits.filter(isDue);
    var fresh = dues.filter(function (c) { return !alerted[c.id + '|' + c.rappel]; });
    if (!fresh.length) return;
    dues.forEach(function (c) { alerted[c.id + '|' + c.rappel] = true; });
    showOverlay(dues);
  }

  /* Actions sur la liste */
  function find(id) { return credits.find(function (x) { return x.id === id; }); }
  function onAction(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act, id = b.dataset.id;
    if (act === 'zoom') { b.classList.toggle('big'); return; }
    var orig = id ? find(id) : null;
    var c = orig ? clone(orig) : null;
    if (act === 'newform') { openForm(true); return; }
    if (act === 'sample') {
      commit({ id: newId(), nom: 'Exemple : Awa Traoré', tel: '', note: 'Exemple à supprimer', total: 250000, rappel: todayIso(), createdAt: todayIso(), versements: [{ date: todayIso(), montant: 100000, label: 'Avance' }] });
      return;
    }
    if (act === 'ovclose') { closeOverlay(); return; }
    if (act === 'ovview') { closeOverlay(); var a = $('#alerts'); if (!a.hidden) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (!c) return;
    if (act === 'view') { openIds[id] = true; render(); var el = document.getElementById('c-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (act === 'toggle') { openIds[id] = !openIds[id]; if (!openIds[id]) confirmDel = null; render(); return; }
    if (act === 'pay') {
      var inp = document.getElementById('p-' + id);
      var m = round2(Number(inp && inp.value));
      if (!(m > 0)) { toast('Saisissez le montant reçu.'); return; }
      if (m > reste(c)) { toast('Ce versement dépasse le reste à payer (' + nf(reste(c)) + ' FCFA).'); return; }
      c.versements.push({ date: todayIso(), montant: m });
      commit(c); toast('Versement enregistré'); return;
    }
    if (act === 'settle') {
      c.versements.push({ date: todayIso(), montant: reste(c), label: 'Solde' });
      commit(c); toast('Crédit soldé'); return;
    }
    if (act === 'rmpiece') {
      var side = b.dataset.side;
      pieceDelete(id, side).then(function () {
        c.pieces = c.pieces || {}; c.pieces[side] = false; commit(c); toast('Photo retirée');
      }).catch(function () { toast('Impossible de retirer la photo. Réessayez.'); });
      return;
    }
    if (act === 'rmv') { c.versements.splice(Number(b.dataset.i), 1); commit(c); toast('Versement retiré'); return; }
    if (act === 'delay') { c.rappel = addDays(todayIso(), 7); commit(c); toast('Rappel reporté au ' + fmtDate(c.rappel)); return; }
    if (act === 'setdate') {
      var v = document.getElementById('rd-' + id).value;
      if (!v) { toast('Choisissez une date.'); return; }
      c.rappel = v; commit(c); toast('Date de rappel modifiée'); return;
    }
    if (act === 'del') { confirmDel = id; render(); return; }
    if (act === 'delno') { confirmDel = null; render(); return; }
    if (act === 'delyes') {
      confirmDel = null; delete openIds[id];
      SIDES.forEach(function (sd) { if (c.pieces && c.pieces[sd[0]]) pieceDelete(id, sd[0]).catch(function () {}); });
      drop(id); toast('Crédit supprimé'); return;
    }
  }
  $('#list').addEventListener('click', onAction);
  $('#alerts').addEventListener('click', onAction);
  $('#overlay').addEventListener('click', function (e) { if (e.target.id === 'overlay') closeOverlay(); else onAction(e); });
  $('#list').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.pay) {
      e.preventDefault();
      var btn = document.querySelector('[data-act="pay"][data-id="' + e.target.dataset.pay + '"]');
      if (btn) btn.click();
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#overlay').hidden) closeOverlay(); });

  $('#list').addEventListener('change', async function (e) {
    var t = e.target;
    if (!t.dataset || !t.dataset.file) return;
    var parts = t.dataset.file.split('|'), id = parts[0], side = parts[1];
    var file = t.files && t.files[0];
    var orig = find(id);
    if (!file || !orig) return;
    try {
      var data = await compress(file);
      await pieceSave(id, side, data);
      var c = clone(find(id) || orig);
      c.pieces = c.pieces || {}; c.pieces[side] = true;
      commit(c); toast('Photo enregistrée');
    } catch (err) {
      toast(err && err.message === 'type' ? 'Choisissez une image (photo ou scan).' : "Impossible d'enregistrer cette photo.");
    }
  });

  /* Filtres et recherche */
  $('#filters').addEventListener('click', function (e) {
    var b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderList();
  });
  $('#search').addEventListener('input', function (e) { query = e.target.value; renderList(); });

  /* Formulaire */
  function openForm(open) {
    $('#formPanel').hidden = !open;
    $('#btnNew').setAttribute('aria-expanded', String(open));
    if (open) { $('#fNom').focus(); $('#formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  $('#btnNew').addEventListener('click', function () { openForm($('#formPanel').hidden); });
  $('#btnCancel').addEventListener('click', function () { $('#form').reset(); updateLive(); $('#formError').textContent = ''; openForm(false); });
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { $('#fRappel').value = addDays(todayIso(), Number(b.dataset.add)); });
  });
  function updateLive() {
    var t = Number($('#fTotal').value) || 0, a = Number($('#fAvance').value) || 0;
    $('#liveReste').textContent = nf(Math.max(0, round2(t - a))) + ' FCFA';
  }
  $('#fTotal').addEventListener('input', updateLive);
  $('#fAvance').addEventListener('input', updateLive);
  $('#form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#formError');
    var nom = $('#fNom').value.trim();
    var total = round2(Number($('#fTotal').value));
    var avance = round2(Number($('#fAvance').value) || 0);
    var rappel = $('#fRappel').value;
    if (!nom) { err.textContent = 'Indiquez le nom du client.'; $('#fNom').focus(); return; }
    if (!(total > 0)) { err.textContent = 'Indiquez le montant total dû.'; $('#fTotal').focus(); return; }
    if (avance < 0 || avance > total) { err.textContent = "L'avance ne peut pas dépasser le montant total dû."; $('#fAvance').focus(); return; }
    if (!rappel) { err.textContent = 'Choisissez la date de rappel de recouvrement.'; $('#fRappel').focus(); return; }
    err.textContent = '';
    var sbtn = $('#form button[type="submit"]');
    sbtn.disabled = true;
    var cid = newId();
    var pieces = { recto: false, verso: false };
    var files = { recto: $('#fRecto').files[0], verso: $('#fVerso').files[0] };
    for (var i = 0; i < SIDES.length; i++) {
      var side = SIDES[i][0];
      if (!files[side]) continue;
      try { await pieceSave(cid, side, await compress(files[side])); pieces[side] = true; }
      catch (ex) { toast("La photo (" + SIDES[i][1].toLowerCase() + ") n'a pas pu être enregistrée. Vous pourrez la rajouter ensuite."); }
    }
    commit({
      id: cid, nom: nom, tel: $('#fTel').value.trim(), note: $('#fNote').value.trim(),
      total: total, rappel: rappel, createdAt: todayIso(), pieces: pieces,
      versements: avance > 0 ? [{ date: todayIso(), montant: avance, label: 'Avance' }] : []
    });
    sbtn.disabled = false;
    $('#form').reset(); updateLive(); openForm(false);
    toast('Crédit enregistré');
  });

  /* Logo : anneau orange, étoile verte et S central */
  var LOGO_PNG = 'icons/logo-ring.png';
  var LOGO_S = 'M42 210H224Q228 171 251.0 150.5Q274 130 311 130Q349 130 371.0 147.5Q393 165 393 196Q393 222 375.5 239.0Q358 256 332.5 267.0Q307 278 260 292Q192 313 149.0 334.0Q106 355 75.0 396.0Q44 437 44 503Q44 601 115.0 656.5Q186 712 300 712Q416 712 487.0 656.5Q558 601 563 502H378Q376 536 353.0 555.5Q330 575 294 575Q263 575 244.0 558.5Q225 542 225 511Q225 477 257.0 458.0Q289 439 357 417Q425 394 467.5 373.0Q510 352 541.0 312.0Q572 272 572 209Q572 149 541.5 100.0Q511 51 453.0 22.0Q395 -7 316 -7Q239 -7 178.0 18.0Q117 43 80.5 92.0Q44 141 42 210Z';
  function logoSvg(size) {
    return '<svg class="logo" xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 400 400" role="img" aria-label="Logo S crédits">' +
      '<image href="' + LOGO_PNG + '" x="0" y="0" width="400" height="400"/>' +
      '<path class="logo-s" transform="translate(124.95 286.05) scale(0.24478 -0.24478)" d="' + LOGO_S + '"/></svg>';
  }

  /* Licence et espace administrateur */
  var DEFAULT_HASH = '95f675058ac079e6a7be4f2129e460f984eb57ce01a9ae5a310dfaf3b6224adc';
  var dbRef = null, isOwner = false;
  var license = null, licenseKnown = false, licFailed = false, lstate = 'loading', prevState = '';
  var adStep = 'code', adFails = 0, adLockUntil = 0;

  function evalLicense() {
    if (!licenseKnown) return licFailed ? 'unverifiable' : 'loading';
    if (!license || !license.expiresAt) return 'none';
    return todayIso() <= license.expiresAt ? 'ok' : 'expired';
  }
  function daysLeft() { return daysBetween(todayIso(), license.expiresAt); }
  function contactTxt() { return license && license.contact ? ' : <strong>' + esc(license.contact) + '</strong>' : ''; }

  function renderLicBar() {
    var el = $('#licBanner');
    if (!license || !license.expiresAt) { el.hidden = true; return; }
    var n = daysLeft();
    if (n > 7) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = 'Votre licence expire le <strong>' + fmtDate(license.expiresAt) + '</strong> (' + (n === 0 ? "aujourd'hui" : 'dans ' + n + (n === 1 ? ' jour' : ' jours')) + "). Pour la prolonger, contactez l'administrateur" + contactTxt() + '.';
  }
  function renderLock() {
    var h;
    if (lstate === 'loading') h = '<p>Vérification de la licence…</p>';
    else if (lstate === 'unverifiable') h = "<h2>Licence non vérifiée</h2><p>Impossible de lire la licence enregistrée sur cet appareil. Rechargez la page. Si le problème continue, contactez l'administrateur.</p>";
    else if (lstate === 'none') h = "<h2>Licence non activée</h2><p>Cette application n'est pas encore activée. Contactez l'administrateur pour obtenir votre accès" + contactTxt() + '.</p>';
    else h = "<h2>Votre licence a expiré</h2><p>Votre durée d'utilisation est arrivée à son terme le <strong>" + fmtDate(license.expiresAt) + "</strong>. Pour continuer à utiliser S crédits, contactez l'administrateur afin de relancer le délai" + contactTxt() + '.</p><p class="muted">Vos crédits et vos pièces d\'identité sont conservés. Ils reviendront dès que la licence sera renouvelée.</p>';
    if (isOwner && lstate !== 'loading') h += '<button class="btn" type="button" data-adm="open">Espace administrateur</button>';
    $('#lock').innerHTML = '<div class="lock-card"><div class="lockup lock-brand">' + logoSvg(96) + '<span class="wordmark" aria-hidden="true">crédits</span></div>' + h + '</div>';
  }
  function applyGate() {
    lstate = evalLicense();
    var ok = lstate === 'ok';
    $('#app').hidden = !ok;
    $('#lock').hidden = ok;
    if (!ok) { if (!$('#overlay').hidden) closeOverlay(); renderLock(); }
    else {
      renderLicBar();
      if (prevState !== 'ok' && loaded) { render(); checkDue(); }
    }
    $('#btnAdmin').hidden = !(ok && isOwner);
    if (!$('#adminOv').hidden) updateAdStatus();
    prevState = lstate;
  }
  function watchLicense(db) {
    var t = setTimeout(function () { if (!licenseKnown) { licFailed = true; applyGate(); } }, 10000);
    db.doc('license/main').onSnapshot(function (s) {
      if (!s.exists && s.metadata.fromCache) return;
      license = s.exists ? s.data() : null;
      licenseKnown = true; licFailed = false;
      clearTimeout(t);
      applyGate();
    }, function () { licFailed = true; applyGate(); });
  }

  /* SHA-256 de secours pour les pages ouvertes sans HTTPS (ex. test en réseau local) */
  function sha256Fallback(msg) {
    var utf8 = unescape(encodeURIComponent(msg)), bytes = [], i;
    for (i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
    var K = [], H = [], primes = [], n = 2;
    while (primes.length < 64) {
      var isP = true;
      for (var q = 0; q < primes.length && primes[q] * primes[q] <= n; q++) { if (n % primes[q] === 0) { isP = false; break; } }
      if (isP) primes.push(n);
      n++;
    }
    for (i = 0; i < 64; i++) K[i] = Math.floor((Math.cbrt(primes[i]) % 1) * 4294967296) >>> 0;
    for (i = 0; i < 8; i++) H[i] = Math.floor((Math.sqrt(primes[i]) % 1) * 4294967296) >>> 0;
    var l = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(l / 4294967296), lo = l >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    function rotr(x, k) { return (x >>> k) | (x << (32 - k)); }
    for (var off = 0; off < bytes.length; off += 64) {
      var w = [];
      for (i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  async function sha(s) {
    if (!(window.crypto && window.crypto.subtle)) return sha256Fallback(s);
    var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  async function verifyCode(code) {
    var pin = null;
    try { var s = await dbRef.doc('admin/pin').get(); if (s.exists) pin = s.data(); } catch (e) { pin = null; }
    if (pin && pin.hash && pin.salt) return (await sha(pin.salt + code)) === pin.hash;
    return (await sha('carnet:' + code)) === DEFAULT_HASH;
  }
  async function writeLicense(patch) {
    var next = Object.assign({}, license || {}, patch, { updatedAt: new Date().toISOString() });
    try {
      await dbRef.doc('license/main').set(next);
      license = next; licenseKnown = true; applyGate();
      toast('Licence mise à jour');
    } catch (e) { toast("Modification impossible. Réessayez."); }
  }
  function baseDate() {
    var t = todayIso();
    return license && license.expiresAt && license.expiresAt > t ? license.expiresAt : t;
  }

  function openAdmin() {
    adStep = 'code'; renderAdmin();
    $('#adminOv').hidden = false;
    var i = $('#adCode'); if (i) i.focus();
  }
  function closeAdmin() { $('#adminOv').hidden = true; adStep = 'code'; $('#adDialog').innerHTML = ''; }
  function updateAdStatus() {
    var el = $('#adStatus');
    if (!el) return;
    if (!license || !license.expiresAt) { el.textContent = "Licence non activée. Ajoutez du temps pour l'activer."; return; }
    var n = daysLeft();
    el.innerHTML = (n < 0 ? 'Licence expirée depuis le ' : "Licence valable jusqu'au ") + '<strong>' + fmtDate(license.expiresAt) + '</strong>' +
      (n >= 0 ? ' (' + n + (n <= 1 ? ' jour restant)' : ' jours restants)') : '') + '.';
  }
  function renderAdmin() {
    var d = $('#adDialog');
    if (adStep === 'code') {
      d.innerHTML = '<h2 id="adTitle">Espace administrateur</h2><p>Saisissez le code administrateur pour gérer la licence.</p>' +
        '<div class="field"><label for="adCode">Code administrateur</label><input id="adCode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
        '<p class="form-error" id="adErr" role="alert"></p>' +
        '<div class="acts"><button class="btn" type="button" data-adm="close">Annuler</button><button class="btn btn-primary" type="button" data-adm="check">Valider</button></div>';
      return;
    }
    d.innerHTML = '<h2 id="adTitle">Gestion de la licence</h2><p class="adstat" id="adStatus"></p>' +
      '<div class="adsec"><h3>Ajouter du temps</h3><div class="chips">' +
        [7, 30, 90, 365].map(function (n) { return '<button class="chip" type="button" data-adm="add" data-n="' + n + '">+ ' + n + ' jours</button>'; }).join('') + '</div></div>' +
      '<div class="adsec"><h3>Durée personnalisée</h3><div class="row-edit"><label>Nombre de jours<input id="adDays" type="number" min="1" step="1" inputmode="numeric" placeholder="Ex. 15"></label>' +
        '<button class="btn btn-small btn-primary" type="button" data-adm="addc">Ajouter</button><button class="btn btn-small" type="button" data-adm="subc">Retirer</button></div>' +
        '<p class="hint">Retirer des jours peut bloquer l\'application immédiatement.</p></div>' +
      '<div class="adsec"><h3>Date d\'expiration exacte</h3><div class="row-edit"><label>Expire le<input id="adDate" type="date" value="' + esc(license && license.expiresAt || '') + '"></label>' +
        '<button class="btn btn-small" type="button" data-adm="setdate">Appliquer</button></div></div>' +
      '<div class="adsec"><h3>Contact affiché aux utilisateurs</h3><div class="row-edit"><label>Téléphone ou e-mail<input id="adContact" type="text" autocomplete="off" value="' + esc(license && license.contact || '') + '"></label>' +
        '<button class="btn btn-small" type="button" data-adm="contact">Enregistrer</button></div></div>' +
      '<div class="adsec"><h3>Code administrateur</h3><div class="row-edit"><label>Nouveau code<input id="adNew" type="password" autocomplete="new-password"></label>' +
        '<label>Confirmer<input id="adNew2" type="password" autocomplete="new-password"></label>' +
        '<button class="btn btn-small" type="button" data-adm="pin">Changer le code</button></div></div>' +
      '<div class="acts"><button class="btn" type="button" data-adm="close">Quitter l\'espace administrateur</button></div>';
    updateAdStatus();
  }
  async function adCheck() {
    var err = $('#adErr'), inp = $('#adCode');
    if (!inp) return;
    if (Date.now() < adLockUntil) { err.textContent = 'Trop d\'essais. Réessayez dans ' + Math.ceil((adLockUntil - Date.now()) / 1000) + ' secondes.'; return; }
    var code = (inp.value || '').trim().toUpperCase();
    if (!code) { err.textContent = 'Saisissez le code.'; return; }
    var ok = false;
    try { ok = await verifyCode(code); } catch (e) { err.textContent = 'Vérification impossible sur cet appareil.'; return; }
    if (ok) { adFails = 0; adStep = 'panel'; renderAdmin(); return; }
    adFails++; inp.value = '';
    if (adFails >= 5) { adLockUntil = Date.now() + 30000; adFails = 0; err.textContent = 'Code incorrect. Nouvel essai possible dans 30 secondes.'; }
    else err.textContent = 'Code incorrect.';
  }
  async function changePin() {
    var a = ($('#adNew').value || '').trim().toUpperCase(), b = ($('#adNew2').value || '').trim().toUpperCase();
    if (a.length < 4) { toast('Le code doit contenir au moins 4 caractères.'); return; }
    if (a !== b) { toast('Les deux codes ne sont pas identiques.'); return; }
    try {
      var salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      await dbRef.doc('admin/pin').set({ salt: salt, hash: await sha(salt + a), updatedAt: new Date().toISOString() });
      $('#adNew').value = ''; $('#adNew2').value = '';
      toast('Code administrateur modifié');
    } catch (e) { toast("Le code n'a pas pu être modifié."); }
  }
  function customDays() { var n = Math.floor(Number($('#adDays').value)); return n > 0 ? Math.min(n, 3650) : 0; }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-adm]');
    if (!b) return;
    var a = b.dataset.adm;
    if (a === 'open') { if (isOwner) openAdmin(); return; }
    if (a === 'close') { closeAdmin(); return; }
    if (a === 'check') { adCheck(); return; }
    if (adStep !== 'panel' || !isOwner) return;
    if (a === 'add') { writeLicense({ expiresAt: addDays(baseDate(), Number(b.dataset.n)) }); return; }
    if (a === 'addc') { var n1 = customDays(); if (!n1) { toast('Indiquez un nombre de jours.'); return; } writeLicense({ expiresAt: addDays(baseDate(), n1) }); return; }
    if (a === 'subc') { var n2 = customDays(); if (!n2) { toast('Indiquez un nombre de jours.'); return; } writeLicense({ expiresAt: addDays(license && license.expiresAt || todayIso(), -n2) }); return; }
    if (a === 'setdate') { var v = $('#adDate').value; if (!v) { toast('Choisissez une date.'); return; } writeLicense({ expiresAt: v }); return; }
    if (a === 'contact') { writeLicense({ contact: $('#adContact').value.trim() }); return; }
    if (a === 'pin') { changePin(); return; }
  });
  $('#adminOv').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'adCode') { e.preventDefault(); adCheck(); }
    if (e.key === 'Escape') closeAdmin();
  });

  /* Démarrage */
  function ready() {
    loaded = true;
    lastDay = todayIso();
    render();
    checkDue();
  }
  async function start() {
    $('#logoHead').innerHTML = logoSvg(92);
    render();
    applyGate();
    var db = null, uid = null;
    try {
      if (window.SCreditsStore && window.SCreditsStore.use) {
        var user = await window.SCreditsStore.use('user');
        uid = user ? await user.id() : null;
        db = uid ? await window.SCreditsStore.use('db') : null;
      }
    } catch (e) { db = null; }
    dbRef = db;
    if (!db || !uid) { licFailed = true; applyGate(); return; }
    try { var u2 = await window.SCreditsStore.use('user'); isOwner = !!(u2 && await u2.isOwner()); } catch (e) { isOwner = false; }
    watchLicense(db);
    if (db && uid) {
      mode = 'cloud';
      col = db.collection('data/users/' + uid);
      var timer = setTimeout(function () { slow = true; renderFoot(); }, 10000);
      col.onSnapshot(function (snap) {
        if (!snap.metadata.fromCache) { clearTimeout(timer); slow = false; }
        credits = snap.docs.map(function (d) { var o = normalize(clone(d.data())); o.id = d.id; return o; });
        if (!loaded) ready(); else { render(); checkDue(); }
      }, function () {
        clearTimeout(timer); loadError = true; loaded = true; render();
      });
    } else {
      mode = 'local';
      loadLocal();
      credits = credits.map(normalize);
      ready();
    }
  }
  start();

  /* Vérification périodique : changement de jour et nouvelles échéances */
  setInterval(function () {
    applyGate();
    if (!loaded) return;
    var d = todayIso();
    if (d !== lastDay) { lastDay = d; render(); }
    checkDue();
  }, 60000);
})();
