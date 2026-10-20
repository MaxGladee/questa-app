// Сервис-воркер: приложение открывается и без сети.
//
// Зачем он нужен. Без него страница, добавленная на домашний экран, в метро
// или в подвале кафе показывает ошибку браузера — то есть именно там, где
// приложением и пользуются. С ним оболочка приложения берётся из кэша, а
// данные подтягиваются, когда связь вернётся.
//
// Три стратегии, и различать их принципиально:
//   • переходы по страницам и index.html — сначала сеть. Иначе после
//     очередной выкладки люди неделями сидели бы на старой версии.
//   • файлы сборки из /assets/ — сначала кэш: в их именах есть хэш
//     содержимого, оно никогда не меняется, меняется имя.
//   • всё остальное своё — картинки, иконки, манифест — отдаём из кэша,
//     но тут же тянем свежее в фоне. Имена у них постоянные, и правило
//     «сначала кэш» держало бы старую картинку вечно: именно так заменённая
//     иконка приложения продолжала показываться прежней.
//
// Запросы к базе, картам и хранилищу снимков через воркер не проходят:
// это чужие адреса, и кэшировать ответы с личными данными не следует.

const CACHE = 'questa-v4'

/*
 * Снимки и обложки лежат отдельно от оболочки: их много, они тяжёлые и
 * живут своей жизнью. Раньше они не кэшировались вовсе — чужой адрес, а
 * чужое воркер не трогает, — и список встреч каждый раз заново качал одни
 * и те же картинки, в том числе по мобильному интернету.
 *
 * Кэшируются только публичные файлы хранилища: их адрес открыт всем, и
 * личного в них не больше, чем в самой встрече. Всё остальное с чужих
 * адресов — запросы к базе, карты — по-прежнему идёт мимо.
 */
const MEDIA = 'questa-media-v1'
const MEDIA_LIMIT = 120

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['./', './index.html'])).catch(() => {}),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          // Отметку «приложение на экране» не трогаем: она не кэш, а связь
          // с открытым приложением (см. appOnScreen ниже).
          .filter((name) => name !== CACHE && name !== MEDIA && name !== 'questa-presence')
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  )
})

async function fromNetworkFirst (request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (failure) {
    const cached = await cache.match(request) || await cache.match('./index.html')
    if (cached) return cached
    throw failure
  }
}

async function fromCacheFirst (request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  // Файла нет в кэше — идём в сеть. Неудачный ответ (404 после выкладки,
  // обрыв связи) не кэшируем: иначе поломка застряла бы в кэше насовсем, и
  // экран, который её ждёт, не открылся бы уже никогда.
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

/** Отдаём из кэша сразу, а следом обновляем его свежим ответом. */
async function fromCacheThenUpdate (request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)

  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => null)

  if (cached) return cached

  const response = await fresh
  if (response) return response

  throw new Error('offline')
}

/**
 * Картинка из хранилища: сначала кэш, и только потом сеть.
 *
 * Адрес снимка постоянный — файл под ним не меняется, его заменяют новым
 * именем. Поэтому обновлять кэш в фоне незачем: взяли один раз и показываем
 * мгновенно, хоть в метро.
 *
 * Кэш подрезается по числу файлов: сотня обложек — это мегабайты, и расти
 * бесконечно ему нельзя. Выбрасываются самые старые записи.
 */
async function fromMedia (request) {
  const cache = await caches.open(MEDIA)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())

    const keys = await cache.keys()
    if (keys.length > MEDIA_LIMIT) {
      await Promise.all(keys.slice(0, keys.length - MEDIA_LIMIT).map((key) => cache.delete(key)))
    }
  }

  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (url.origin !== self.location.origin) {
    if (url.pathname.includes('/storage/v1/object/public/')) event.respondWith(fromMedia(request))
    return
  }

  if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(fromNetworkFirst(request))
    return
  }

  // Имя файла сборки содержит хэш содержимого — такой файл не меняется.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(fromCacheFirst(request))
    return
  }

  event.respondWith(fromCacheThenUpdate(request))
})

/*
 * Пуш-уведомления.
 *
 * Сюда воркер попадает, когда приложение закрыто: служба доставки будит
 * его ради одного сообщения. Показать уведомление обязательно — браузер
 * дал разрешение именно на видимые, и молчаливый пуш он посчитает
 * нарушением и со временем отзовёт подписку.
 */
/*
 * Приложение само отмечается, пока оно на экране (src/lib/presence.ts).
 *
 * Список окон выше на iPhone ненадёжен: открытое приложение числилось
 * скрытым, и уведомление приходило дважды — системой и плашкой внутри.
 * Отметка свежее сорока секунд значит «человек сейчас в приложении».
 */
async function appOnScreen () {
  try {
    const cache = await caches.open('questa-presence')
    const saved = await cache.match('./__presence')
    if (!saved) return false
    const { at } = await saved.json()
    return typeof at === 'number' && Date.now() - at < 40_000
  } catch {
    return false
  }
}

/*
 * Цифра на значке приложения: +1 на каждое уведомление, пока приложение
 * закрыто. Точное число знает только база — открытое приложение сверит
 * его само (src/lib/badge.ts), а здесь считаем от того, что оно записало.
 */
async function bumpBadge () {
  if (!self.navigator.setAppBadge) return
  try {
    const cache = await caches.open('questa-presence')
    const saved = await cache.match('./__badge')
    const count = (saved ? (await saved.json()).count : 0) + 1
    await cache.put('./__badge', new Response(JSON.stringify({ count })))
    await self.navigator.setAppBadge(count)
  } catch {
    // Не вышло — уведомление всё равно покажем.
  }
}

self.addEventListener('push', (event) => {
  let notice = { title: 'Questa', body: '', url: '#/' }

  try {
    notice = { ...notice, ...(event.data ? event.data.json() : {}) }
  } catch {
    // Письмо без разбираемого содержимого — покажем хотя бы название.
  }

  event.waitUntil((async () => {
    /*
     * Приложение открыто — уведомление не показываем.
     *
     * Внутри уже есть своя плашка сверху, со звуком и переходом по
     * нажатию. Системное поверх неё — то же самое второй раз: в чате это
     * особенно заметно, каждое сообщение приходило дважды.
     *
     * Оговорка: браузер вправе показать своё «сайт обновился в фоне»,
     * если приложение слишком часто получает пуши и ничего не показывает.
     * На деле до этого не доходит — пуши приходят как раз тогда, когда
     * приложение закрыто, а открытым оно бывает считанные минуты в день.
     */
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const watching = windows.some((client) =>
      (client.visibilityState === 'visible' || client.focused)
      && client.url.startsWith(self.registration.scope))
      || await appOnScreen()

    // Исключение — проверочный пуш со страницы самопроверки. Её нажимают
    // именно в открытом приложении, и правило выше делало проверку
    // бессмысленной: цепочка работает, уведомления нет, и понять, почему,
    // неоткуда.
    // Признак force приносит функция push; до её обновления узнаём
    // проверку по адресу — других пушей на экран самопроверки не бывает.
    if (watching && !notice.force && notice.url !== '#/health') return

    await bumpBadge()

    await showGrouped(notice)
  })())
})

/*
 * Уведомления одной встречи — одним уведомлением.
 *
 * Раньше каждое новое заменяло прежнее той же встречи, и прочесть
 * удавалось только последнее: «задание выполнено» стирало «группа
 * набрана». Теперь новое забирает строки прежнего: сверху свежее, ниже —
 * что пришло до него, в заголовке — сколько всего. Чат и события встречи
 * собираются вместе: ключ — сама встреча, а не адрес экрана.
 */
const GROUP_LINES = 5

async function showGrouped (notice) {
  const event = /#\/event\/([^/?]+)/.exec(notice.url || '')
  const tag = event ? `event:${event[1]}` : notice.url
  // Чат присылает заголовком название встречи, а текстом — «Имя: сообщение».
  const chat = /\/chat$/.test(notice.url || '')
  const line = chat || !notice.body ? (notice.body || notice.title) : `${notice.title} — ${notice.body}`

  let before = { lines: [], count: 0, meeting: null }
  if (event && self.registration.getNotifications) {
    try {
      const shown = await self.registration.getNotifications({ tag })
      const last = shown[shown.length - 1]
      if (last && last.data && Array.isArray(last.data.lines)) before = last.data
      for (const item of shown) item.close()
    } catch {
      // Не узнали прежние — покажем одно новое, как раньше.
    }
  }

  const count = before.count + 1
  const lines = [line, ...before.lines].slice(0, GROUP_LINES)
  const meeting = (chat && notice.title) || before.meeting
  const grouped = count > 1

  await self.registration.showNotification(
    grouped ? `${meeting || notice.title} · ${count} новых` : notice.title,
    {
      body: grouped
        ? lines.join('\n') + (count > lines.length ? `\nи ещё ${count - lines.length}` : '')
        : notice.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag,
      renotify: true,
      data: { url: notice.url, lines, count, meeting },
    },
  )
}

/*
 * Нажатие на уведомление. Если приложение уже открыто, переводим его на
 * нужный экран и поднимаем окно; если нет — открываем.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = new URL(
    (event.notification.data && event.notification.data.url) || './',
    self.registration.scope,
  ).href

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus()
        // Адрес меняем сообщением: navigate() перезагрузил бы приложение.
        client.postMessage({ questa: 'open', url: target })
        return
      }
    }

    await self.clients.openWindow(target)
  })())
})
