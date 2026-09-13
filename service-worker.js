/**
 * Service worker.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/icons): precached, served cache-first, refreshed in
 *     the background. A cadet on detachment wifi should never wait on the network
 *     to see the UI.
 *   - Navigations: network-first, falling back to the cached shell so the app
 *     opens offline.
 *   - Google APIs and anything cross-origin: never cached. Feedback data must be
 *     read live, and a stale Drive response would be worse than an honest error.
 *
 * Bump CACHE_VERSION on release to roll users onto new assets.
 */

const CACHE_VERSION = 'v42';
const CACHE_NAME = `nine31-shell-${CACHE_VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './about.html',
  './privacy.html',
  './terms.html',
  './css/styles.css',
  './js/analysis/lexicon.js',
  './js/analysis/stats.js',
  './js/analysis/text.js',
  './js/analysis/wordcloud.js',
  './js/app.js',
  './js/audit.js',
  './js/auth.js',
  './js/config.js',
  './js/export-anon.js',
  './js/forms.js',
  './js/google-identity.js',
  './js/join.js',
  './js/panels.js',
  './js/people-scope.js',
  './js/session.js',
  './js/spaces.js',
  './js/qr.js',
  './js/data-source.js',
  './js/migrations.js',
  './js/router.js',
  './js/state.js',
  './js/storage/drive.js',
  './js/storage/folder.js',
  './js/storage/idb.js',
  './js/storage/index.js',
  './js/storage/local.js',
  './js/storage/proxy.js',
  './js/storage/queue.js',
  './js/util.js',
  './js/views/admin.js',
  './js/views/analysis.js',
  './js/views/formCreator.js',
  './js/views/home.js',
  './js/views/instructor.js',
  './js/views/people.js',
  './js/views/invite.js',
  './js/views/join.js',
  './js/views/settings.js',
  './js/views/sign-in.js',
  './js/views/setup.js',
  './js/views/student.js',
  './icons/icon.svg',
  // The PNGs index.html and manifest.json name. Without them a first offline
  // launch on iOS, and an offline install prompt, have no icon.
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is all-or-nothing; add individually so one missing optional asset
    // (an icon that has not been generated yet) cannot break the install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch((err) => {
      console.warn('[sw] skipped precache', url, err.message);
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      // Both prefixes: caches written before the rename would otherwise sit in
      // every existing browser forever, since nothing would ever match them.
      .filter((name) => (name.startsWith('nine31-shell-') || name.startsWith('topfb-shell-'))
        && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only: Drive, Google sign-in, and any other host go straight out.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: false });

    const network = fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    }).catch(() => null);

    // Stale-while-revalidate: instant from cache, freshened for next time.
    return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
