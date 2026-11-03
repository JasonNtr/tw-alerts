/* TW Alerts - the phone's service worker.
 *
 * Chrome wakes this when the tray app sends a push, even with the page closed and the screen off. It must show a notification
 * for every push (a browser rule, userVisibleOnly), so a message it cannot read is still shown, as a generic alert.
 *
 * Urgent alerts stay on screen until touched (requireInteraction) and, when the tray app repeats one, re-alert instead of piling up:
 * every repeat of an alert carries the same tag, and renotify makes Chrome sound and vibrate again for it. Touching the notification,
 * its "Got it" button, or swiping it away tells the tray app it was seen by writing "ack <id>" through the Discord webhook the
 * pairing link gave this page; the tray app then stops repeating that alert.
 *
 * The sound is NOT chosen here. Android gives every site its own notification category: long-press one of these notifications,
 * open its settings, and pick an alarm sound, vibration and "override Do Not Disturb" for it. Discord's sound is untouched.
 */
'use strict';

const DB_NAME = 'tw-phone';
const STORE = 'kv';

function openDb() {
    return new Promise(function (resolve, reject) {
        const req = self.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

function kvGet(key) {
    return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            r.onsuccess = function () { resolve(r.result); };
            r.onerror = function () { reject(r.error); };
        });
    });
}

function kvSet(key, value) {
    return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

const URGENT_VIBRATION = [700, 250, 700, 250, 700, 250, 1200];

function show(raw) {
    let d = null;
    try { d = raw && raw.json ? raw.json() : null; } catch (e) { d = null; }
    if (!d || typeof d !== 'object') d = { title: 'TW alert', body: 'Something needs you. Open Discord.', urgent: true, id: '' };
    const urgent = d.urgent !== false;
    const id = /^[a-z0-9]{3,24}$/.test(String(d.id || '')) ? String(d.id) : '';
    const options = {
        body: String(d.body || '').slice(0, 500),
        tag: id || ('tw-' + (d.kind || 'alert')),
        renotify: true,
        requireInteraction: urgent,
        silent: false,
        vibrate: urgent ? URGENT_VIBRATION : [250],
        timestamp: typeof d.at === 'number' ? d.at : Date.now(),
        data: { id: id, urgent: urgent }
    };
    if (urgent && id) options.actions = [{ action: 'ack', title: 'Got it' }];
    return self.registration.showNotification(String(d.title || 'TW alert').slice(0, 100), options);
}

/** Tell the tray app this alert was seen. Tries a few times; if the network is down the tray app simply sends it again. */
function ack(id) {
    if (!id) return Promise.resolve();
    return kvGet('hook').then(function (hook) {
        if (!hook) return;
        let attempt = 0;
        const go = function () {
            return self.fetch(hook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'ack ' + id, username: 'TW Phone', allowed_mentions: { parse: [] } })
            }).then(function (res) {
                if (res && res.ok === false && res.status >= 500 && ++attempt < 3) return new Promise(function (r) { setTimeout(r, 1500); }).then(go);
            }, function () {
                if (++attempt < 3) return new Promise(function (r) { setTimeout(r, 1500); }).then(go);
            });
        };
        return go();
    }).catch(function () { /* no stored hook, or storage unavailable: nothing to tell */ });
}

self.addEventListener('push', function (event) {
    event.waitUntil(show(event.data));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const data = event.notification.data || {};
    event.waitUntil(ack(data.id));
});

self.addEventListener('notificationclose', function (event) {
    const data = event.notification.data || {};
    event.waitUntil(ack(data.id));
});

/** base64url of bytes, the form the tray app reads. */
function b64u(bytes) {
    let s = '';
    new Uint8Array(bytes).forEach(function (c) { s += String.fromCharCode(c); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* The browser replaced the phone's push address. Subscribe again with the same key and say so, so the tray app is not left
 * sending to an address that no longer exists. */
self.addEventListener('pushsubscriptionchange', function (event) {
    event.waitUntil(Promise.all([kvGet('key'), kvGet('hook'), kvGet('name')]).then(function (v) {
        if (!v[0] || !v[1]) return;
        return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: v[0] }).then(function (sub) {
            const code = b64u(new TextEncoder().encode(JSON.stringify({ e: sub.endpoint, p: b64u(sub.getKey('p256dh')), a: b64u(sub.getKey('auth')), n: v[2] || 'phone' })));
            return self.fetch(v[1], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'push ' + code, username: 'TW Phone', allowed_mentions: { parse: [] } }) });
        });
    }).catch(function () { /* the next visit to the page pairs again */ }));
});

/* Installed straight away: there is nothing to cache, and an update should take over without waiting for every tab to close. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
