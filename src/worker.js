/**
 * 🍇 PODOLANG RELAY — 전화 통역 (Twilio ConversationRelay 방식)
 * Cloudflare Workers + Durable Object · v7.0
 * © 2026 BJ LEE. All Rights Reserved.  (BJ LEE 전용)
 *
 * v7.0 에서 바뀐 것
 *   이용권(KV)을 없애고 포도톡 크레딧 하나로 모았습니다.
 *   손님이 이용권도 사고 크레딧도 사야 해서 헷갈렸고, 남은 양을
 *   두 군데서 봐야 했습니다. 이제 포도톡 설정 → 크레딧 한 곳만 봅니다.
 *
 *   그리고 잔액만큼만 통화하도록 시간을 미리 재둡니다.
 *   예전에는 1분치만 있으면 몇 시간이든 걸 수 있어서, 100크레딧 가진
 *   사람이 30분을 통화하면 그대로 손해였습니다.
 *
 * 왜 이 구조인가
 *   Cloudflare 워커에서 OpenAI·Gemini 의 실시간 WebSocket 으로 나가면
 *   두 회사 모두 지역차단으로 막습니다 (403 / 1007).
 *   그래서 음성 처리를 Twilio 에 맡기고, 워커는 글자 번역만 합니다.
 *   글자 번역(HTTP)은 AI Gateway 로 이미 잘 나갑니다.
 *
 * 흐름
 *   상대(영어) → Twilio STT → prompt(글자) → 워커 → GPT 번역 → 내 폰 (자막 + 폰 음성합성)
 *   나(한국어) → 폰 음성인식 → 글자 → 워커 → GPT 번역 → Twilio TTS → 상대 (영어 음성)
 *
 *   워커가 다루는 건 전부 글자입니다. 오디오 변환이 하나도 없습니다.
 */

/* ===================== 설정 ===================== */

// 글자 번역은 게이트웨이 경유 (지역차단 우회가 확인된 경로)
const CF_ACCOUNT_ID = '8e3361d320715cc98e7b66cb3127ca76';
const CF_GATEWAY = 'podolang';
const OPENAI_HTTP = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY}/openai`;
const TRANSLATE_MODEL = 'gpt-4o-mini';

const ALLOWED = [
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://podotalk.kr',
  'https://www.podotalk.kr',
  'https://byoungju-web.github.io',
  'http://localhost:8788'
];

// 언어 코드 → Twilio 가 쓰는 BCP-47 (STT/TTS 용)
const BCP = {
  KO:'ko-KR', EN:'en-US', JA:'ja-JP', ZH:'zh-CN', ES:'es-ES', PT:'pt-BR',
  FR:'fr-FR', DE:'de-DE', IT:'it-IT', RU:'ru-RU', HI:'hi-IN', ID:'id-ID',
  VI:'vi-VN', TH:'th-TH', AR:'ar-AE', NL:'nl-NL'
};
// 번역 지시문에 넣을 언어 이름 (영어로 써야 모델이 정확히 알아듣습니다)
const LNAME = {
  KO:'Korean', EN:'English', JA:'Japanese', ZH:'Chinese', ES:'Spanish',
  PT:'Portuguese', FR:'French', DE:'German', IT:'Italian', RU:'Russian',
  HI:'Hindi', ID:'Indonesian', VI:'Vietnamese', TH:'Thai', AR:'Arabic', NL:'Dutch'
};
const up = v => String(v || '').toUpperCase();
const bcp = v => BCP[up(v)] || 'en-US';
const lname = v => LNAME[up(v)] || up(v);

// 상대가 전화를 받으면 처음 들려줄 안내
const GREET = {
  EN: 'This is an interpreted call. Please speak normally and everything will be translated.',
  KO: '통역 전화입니다. 평소처럼 말씀하시면 통역됩니다.',
  JA: '通訳電話です。普通に話していただければ翻訳されます。',
  ZH: '这是翻译电话。请正常讲话，系统会为您翻译。',
  ES: 'Esta es una llamada con interpretacion. Hable normalmente y todo sera traducido.',
  VI: 'Day la cuoc goi co phien dich. Vui long noi binh thuong.',
  ID: 'Ini panggilan dengan penerjemah. Silakan bicara seperti biasa.',
  TH: 'This is an interpreted call. Please speak normally.'
};
const greet = v => GREET[up(v)] || GREET.EN;

/* ===================== 크레딧 (포도톡과 하나로) =====================
   예전에는 여기 KV 에 이용권 코드를 따로 두었습니다. 손님이 이용권도 사고
   크레딧도 사야 해서 헷갈렸고, 남은 양을 두 군데서 봐야 했습니다.
   이제 포도톡 크레딧 하나만 씁니다. 이 워커가 포도톡 서버에 물어보고 깎습니다.

   ⚠️ 검사는 반드시 워커에서 합니다.
      앱에서 막으면 코드를 고쳐서 그냥 통과합니다.
      API 키가 워커에만 있으니 문은 워커가 지켜야 합니다.

   워커 설정에 두 가지를 넣어야 합니다 (Settings → Variables and Secrets)
     TALK_API   (Text)   https://podotalk-api.hasin7jk.workers.dev
     LINK_KEY   (Secret) 포도톡 워커에 넣은 것과 똑같은 글자

   KV(LIC) 는 그대로 둡니다. 어느 통화가 누구 것인지 잠깐 적어두는 데 씁니다. */

const CD_PHONE = 60;   // 전화통역 1분
const CD_TALK  = 1;    // 마주보고 통역 한 마디

const talkApi = env => String(env.TALK_API || 'https://podotalk-api.hasin7jk.workers.dev')
  .replace(/\/+$/, '');

/* 같은 계정의 워커를 workers.dev 주소로 부르면 Cloudflare 가 막습니다
   (error code 1042). 그래서 Service Binding(TALK) 으로 직접 부릅니다.
   대시보드에서 Bindings → Service 로 podotalk-api 를 TALK 이라는 이름에
   연결해 두어야 합니다. 연결이 없으면 예전처럼 주소로 부릅니다. */
async function talkFetch(env, path, init) {
  const req = new Request(talkApi(env) + path, init);
  if (env.TALK && typeof env.TALK.fetch === 'function') {
    return await env.TALK.fetch(req);
  }
  return await fetch(req);
}

const uidOk = v => /^[a-zA-Z0-9_-]{6,64}$/.test(v || '');

/* 얼마나 남았는지 물어봅니다 */
async function cdBalance(env, uid) {
  if (!env.LINK_KEY) return { ok: false, reason: '서버 설정이 끝나지 않았습니다. (LINK_KEY)' };
  if (!uidOk(uid)) {
    return { ok: false, reason: '포도톡에서 열어주세요. 사용자 정보가 없습니다.' };
  }
  try {
    const r = await talkFetch(env, `/link/credits?uid=${encodeURIComponent(uid)}`, {
      headers: { 'X-Link-Key': env.LINK_KEY }
    });
    const d = await r.json();
    if (!d || !d.ok) return { ok: false, reason: '크레딧을 확인하지 못했습니다.' };
    return { ok: true, balance: d.balance || 0, minutes: d.minutes || 0 };
  } catch (e) {
    return { ok: false, reason: '크레딧 서버에 닿지 못했습니다: ' + ((e && e.message) || e) };
  }
}

/* 실제로 깎습니다. 모자라면 남은 만큼만 깎고 얼마를 깎았는지 돌려줍니다. */
async function cdSpend(env, uid, amount, kind) {
  if (!env.LINK_KEY || !uid || !amount) return { ok: false, took: 0 };
  try {
    const r = await talkFetch(env, `/link/credits`, {
      method: 'POST',
      headers: { 'X-Link-Key': env.LINK_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, amount, kind: kind || 'podolang' })
    });
    return await r.json();
  } catch (_) { return { ok: false, took: 0 }; }
}

/* 쓸 수 있는지 봅니다. needMinutes 를 주면 최소 1분치가 있는지까지 봅니다. */
async function cdCheck(env, uid, needMinutes) {
  const b = await cdBalance(env, uid);
  if (!b.ok) return { ok: false, reason: b.reason };
  if (needMinutes && b.balance < CD_PHONE) {
    return { ok: false, reason: '크레딧이 모자랍니다. 포도톡 설정 → 크레딧에서 채워주세요.', balance: b.balance };
  }
  if (!needMinutes && b.balance <= 0) {
    return { ok: false, reason: '크레딧이 없습니다. 포도톡 설정 → 크레딧에서 채워주세요.', balance: b.balance };
  }
  return { ok: true, balance: b.balance, minutes: b.minutes };
}

/* 앱에 보여줄 모양. 예전 licView 자리를 그대로 씁니다. */
function cdView(b) {
  return {
    plan: '크레딧',
    status: 'active',
    남은분: Math.floor((b.balance || 0) / CD_PHONE),
    남은크레딧: b.balance || 0
  };
}

/* 통화가 끝나면 쓴 시간만큼 깎습니다. Twilio 는 분 단위로 과금하니 올림합니다. */
async function cdDeductCall(env, callSid, seconds) {
  if (!env.LIC || !callSid) return;
  const uid = await env.LIC.get('call:' + callSid);
  if (!uid) return;
  const mins = Math.ceil(Math.max(0, seconds) / 60);
  if (mins > 0) await cdSpend(env, uid, mins * CD_PHONE, 'phone');
  await env.LIC.delete('call:' + callSid);
}

/* ===================== Worker ===================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const H = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: H });

    try {
      // 상태 확인
      if (url.pathname === '/api/rt/health') {
        return json({
          ok: true, app: 'podolang-relay', version: '7.1',
          mode: 'Twilio ConversationRelay — 음성은 Twilio, 번역만 워커',
          translateModel: TRANSLATE_MODEL,
          keys: {
            openai: !!env.OPENAI_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
            durableObject: !!env.CALL,
            callStore: !!env.LIC,
            creditLink: !!(env.LINK_KEY && env.TALK_API),
            serviceBinding: !!env.TALK
          }
        }, 200, H);
      }

      /* 크레딧 연결 진단. 포도톡을 실제로 불러보고 받은 답을 그대로 보여줍니다. */
      if (url.pathname === '/api/link/test') {
        const uid = url.searchParams.get('uid') || 'test123456';
        const out = { talkApi: talkApi(env), hasKey: !!env.LINK_KEY,
                      serviceBinding: !!env.TALK, uid };
        try {
          const r = await talkFetch(env, `/link/credits?uid=${encodeURIComponent(uid)}`, {
            headers: { 'X-Link-Key': env.LINK_KEY || '' }
          });
          out.status = r.status;
          out.body = (await r.text()).slice(0, 400);
        } catch (e) {
          out.fetchError = (e && e.message) || String(e);
        }
        return json(out, 200, H);
      }

      // 번역만 따로 시험 (전화 없이) — 게이트웨이가 살아있는지 확인
      if (url.pathname === '/api/rt/testtranslate') {
        const text = url.searchParams.get('text') || '안녕하세요. 다음 주에 500개 보낼 수 있나요?';
        const from = url.searchParams.get('from') || 'ko';
        const to   = url.searchParams.get('to')   || 'en';
        try {
          const t0 = Date.now();
          let first = 0;
          const out = await translateStream(env, text, from, to, () => { if (!first) first = Date.now() - t0; });
          return json({
            ok: true, 원문: text, 번역: out,
            첫조각까지ms: first,          // 상대가 소리를 듣기 시작하는 시점
            전체완료ms: Date.now() - t0
          }, 200, H);
        } catch (e) {
          return json({ ok: false, error: e.message }, 200, H);
        }
      }

      // ---- 크레딧 확인 (앱이 남은 시간을 보여줄 때 씁니다) ----
      //  발급·충전은 포도톡에서 합니다. 여기서는 보기만 합니다.
      if (url.pathname === '/api/lic/check' && request.method === 'POST') {
        const b = await request.json();
        const r = await cdCheck(env, b.uid || '', false);
        return json(r.ok
          ? { ok: true, ...cdView(r) }
          : { ok: false, reason: r.reason }, 200, H);
      }

      // ---- 녹음 조각을 글자로 (Whisper) ----
      //  앱이 안드로이드 음성인식을 쓰지 않고 녹음해서 보냅니다.
      //  그 소리를 켜고 끌 때마다 딸깍 소리가 나서 이 길로 왔습니다.
      //  Whisper 는 게이트웨이 경유라 지역차단을 통과합니다 (확인된 경로).
      if (url.pathname === '/api/stt' && request.method === 'POST') {
        if (!env.OPENAI_API_KEY) return json({ error: 'OpenAI 키가 없습니다.' }, 400, H);
        const fd = await request.formData();
        const audio = fd.get('audio');
        const lang = String(fd.get('lang') || 'ko').toLowerCase();

        // 크레딧이 있어야 씁니다. 없으면 남의 Whisper 가 됩니다.
        const sUid = String(fd.get('uid') || '');
        const lic = await cdCheck(env, sUid, false);
        if (!lic.ok) return json({ error: lic.reason, needCredit: true }, 402, H);

        if (!audio || typeof audio.arrayBuffer !== 'function') {
          return json({ error: '음성이 오지 않았습니다.' }, 400, H);
        }

        // 먼저 깎고 부릅니다. 부르고 나서 깎으면 실패한 요청으로 얼마든지 뽑아갑니다.
        await cdSpend(env, sUid, CD_TALK, 'talk');

        const form = new FormData();
        form.append('file', audio, 'voice.webm');
        form.append('model', 'whisper-1');
        if (lang && lang !== 'auto') form.append('language', lang);
        form.append('temperature', '0');

        const r = await fetch(`${OPENAI_HTTP}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
          body: form
        });
        const raw = await r.text();
        let d;
        try { d = JSON.parse(raw); }
        catch (_) { return json({ error: '음성 인식 응답을 읽지 못했습니다: ' + raw.slice(0, 200) }, 400, H); }
        if (d.error) return json({ error: d.error.message || '음성 인식 실패' }, 400, H);
        return json({ ok: true, text: dedupeRepeat(String(d.text || '')) }, 200, H);
      }

      // ---- 화면 글씨 묶음 번역 ----
      //  앱의 긴 안내문을 한 번에 옮깁니다.
      //  한 번 옮긴 것은 KV 에 넣어두고 다음부터는 그대로 꺼내 씁니다.
      //  크레딧이 없어도 씁니다. 화면 글씨는 누구나 읽어야 하니까요.
      if (url.pathname === '/api/ui/translate' && request.method === 'POST') {
        if (!env.OPENAI_API_KEY) return json({ error: 'OpenAI 키가 없습니다.' }, 400, H);
        const b = await request.json();
        const to = up(b.to || 'EN');
        const items = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
        if (!items.length) return json({ ok: true, texts: {} }, 200, H);
        if (to === 'KO') return json({ ok: true, texts: {} }, 200, H);

        const ver = String(b.ver || '1');
        const cacheKey = `ui:${to}:${ver}`;
        if (env.LIC) {
          const hit = await env.LIC.get(cacheKey, 'json');
          if (hit) return json({ ok: true, cached: true, texts: hit }, 200, H);
        }

        // 줄마다 번호를 붙여 보내고 같은 번호로 돌려받습니다
        const numbered = items.map((x, i) => `${i + 1}. ${String(x.ko || '').replace(/\n/g, ' ⏎ ')}`).join('\n');
        const sys = [
          `Translate each numbered line from Korean into ${lname(to)}.`,
          `These are user-interface strings for a live interpreting app used by small business owners.`,
          `Keep the same numbering and the same number of lines. One line per number.`,
          `Keep HTML tags such as <b> and <br> exactly where they are.`,
          `Keep the symbol ⏎ exactly where it is — it marks a line break.`,
          `Keep product names, phone numbers and codes unchanged.`,
          `Sound natural and plain, the way an app really speaks to its user. Do not translate word for word.`,
          `Output only the numbered lines, nothing else.`
        ].join(' ');

        const res = await fetch(`${OPENAI_HTTP}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: TRANSLATE_MODEL, temperature: 0.2, max_tokens: 4000,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }]
          })
        });
        const raw = await res.text();
        let d;
        try { d = JSON.parse(raw); } catch (_) { return json({ error: '번역 응답을 읽지 못했습니다.' }, 400, H); }
        if (d.error) return json({ error: d.error.message || '번역 실패' }, 400, H);
        const out = (d.choices?.[0]?.message?.content || '').trim();

        const map = {};
        for (const line of out.split(/\n+/)) {
          const m = /^\s*(\d+)[.)]\s*(.+)$/.exec(line);
          if (!m) continue;
          const idx = parseInt(m[1], 10) - 1;
          if (items[idx]) map[items[idx].k] = m[2].trim().replace(/ ?⏎ ?/g, '\n');
        }
        // 빠진 줄은 원문 그대로 둡니다
        for (const it of items) if (!map[it.k]) map[it.k] = it.ko;

        if (env.LIC) {
          try { await env.LIC.put(cacheKey, JSON.stringify(map), { expirationTtl: 60 * 60 * 24 * 180 }); } catch (_) {}
        }
        return json({ ok: true, texts: map }, 200, H);
      }

      // 1. 통화 시작
      if (url.pathname === '/api/rt/start' && request.method === 'POST') {
        if (!env.CALL) return json({ error: 'Durable Object(CALL)가 연결되지 않았습니다.' }, 400, H);
        if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER) {
          return json({ error: 'Twilio 설정이 없습니다.' }, 400, H);
        }
        const body = await request.json();
        const { to, myLang, peerLang } = body;
        if (!/^\+\d{8,15}$/.test(to || '')) {
          return json({ error: '전화번호는 +82… 처럼 국가번호부터 넣어주세요.' }, 400, H);
        }

        // ⚠️ 여기가 문입니다. 크레딧이 없으면 전화가 나가지 않습니다.
        const cUid = String(body.uid || '');
        const lic = await cdCheck(env, cUid, true);
        if (!lic.ok) {
          return json({ error: lic.reason, needCredit: true }, 402, H);
        }

        // 잔액만큼만 통화할 수 있게 시간을 미리 재둡니다.
        // 이게 없으면 100크레딧 가진 사람이 한 시간을 걸어 마이너스가 납니다.
        const maxMin = Math.max(1, Math.floor(lic.balance / CD_PHONE));

        const me = up(myLang || 'KO'), peer = up(peerLang || 'EN');

        const room = crypto.randomUUID().slice(0, 12);
        const stub = env.CALL.get(env.CALL.idFromName(room));
        await stub.fetch(new Request('https://do/config', {
          method: 'POST',
          body: JSON.stringify({ room, me, peer, glossary: body.glossary, tone: body.tone })
        }));

        const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
        const form = new URLSearchParams();
        form.append('To', to);
        form.append('From', env.TWILIO_PHONE_NUMBER);
        form.append('Url', `${url.origin}/twiml/relay/${room}/${peer}`);
        form.append('StatusCallback', `${url.origin}/api/rt/status?room=${room}`);
        form.append('StatusCallbackEvent', 'initiated');
        form.append('StatusCallbackEvent', 'ringing');
        form.append('StatusCallbackEvent', 'answered');
        form.append('StatusCallbackEvent', 'completed');
        form.append('Timeout', '25');
        form.append('TimeLimit', String(maxMin * 60));   // 잔액이 다하면 저절로 끊깁니다

        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form
        });
        const d = await res.json();
        if (d.code) return json({ error: d.message }, 400, H);

        await stub.fetch(new Request('https://do/callsid', {
          method: 'POST', body: JSON.stringify({ callSid: d.sid })
        }));
        // 통화가 끝날 때 누구에게서 깎을지 적어둡니다 (12시간 뒤 자동 삭제)
        try{ await env.LIC.put('call:' + d.sid, cUid, { expirationTtl: 43200 }); }catch(_){}

        return json({
          ok: true, room, callSid: d.sid,
          크레딧: cdView(lic),
          최대통화분: maxMin,
          wsUrl: `${url.origin.replace(/^http/, 'ws')}/rt/app?room=${room}`,
          message: `${to} 로 거는 중입니다.`
        }, 200, H);
      }

      // 2. TwiML — Twilio 가 음성인식·음성합성을 대신합니다.
      //    ⚠️ url 속성에는 쿼리 문자열을 쓸 수 없습니다 (에러 31920).
      //       그래서 방번호와 언어를 경로에 넣습니다.
      if (url.pathname.startsWith('/twiml/relay/')) {
        const seg = url.pathname.split('/').filter(Boolean);   // twiml, relay, room, peer
        const room = seg[2] || '';
        const peer = up(seg[3] || 'EN');
        const ws = `${url.origin.replace(/^http/, 'ws')}/rt/relay/${room}`;

        if (room && env.CALL) {
          try {
            const stub = env.CALL.get(env.CALL.idFromName(room));
            await stub.fetch(new Request('https://do/bump', { method: 'POST' }));
          } catch (_) {}
        }

        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${escXml(ws)}"
      language="${escXml(bcp(peer))}"
      transcriptionProvider="Deepgram"
      ttsProvider="ElevenLabs"
      welcomeGreeting="${escXml(greet(peer))}"
      interruptible="speech"
      reportInputDuringAgentSpeech="none" />
  </Connect>
</Response>`);
      }

      // 3. WebSocket — 앱과 Twilio 양쪽
      if (url.pathname === '/rt/app' || url.pathname.startsWith('/rt/relay')) {
        if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
          return new Response('WebSocket 연결이 필요합니다.', { status: 426 });
        }
        let room = url.searchParams.get('room') || '';
        if (!room && url.pathname.startsWith('/rt/relay/')) {
          room = decodeURIComponent(url.pathname.slice('/rt/relay/'.length));
        }
        if (!room) return new Response('room 없음', { status: 400 });
        const stub = env.CALL.get(env.CALL.idFromName(room));
        return stub.fetch(request);   // 원본 요청 그대로 넘겨야 업그레이드가 삽니다
      }

      // 4. 진단
      if (url.pathname === '/api/rt/debug') {
        const room = url.searchParams.get('room') || '';
        if (!room || !env.CALL) return json({ error: 'room 파라미터가 필요합니다.' }, 400, H);
        const stub = env.CALL.get(env.CALL.idFromName(room));
        const r = await stub.fetch(new Request('https://do/debug'));
        return new Response(await r.text(), { headers: { 'Content-Type': 'application/json', ...H } });
      }

      // 5. 통화 종료
      if (url.pathname === '/api/rt/end' && request.method === 'POST') {
        const { room } = await request.json();
        if (room && env.CALL) {
          const stub = env.CALL.get(env.CALL.idFromName(room));
          const info = await (await stub.fetch(new Request('https://do/info'))).json();
          if (info.callSid && env.TWILIO_ACCOUNT_SID) {
            try {
              const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
              const f = new URLSearchParams(); f.append('Status', 'completed');
              await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${info.callSid}.json`, {
                method: 'POST',
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: f
              });
            } catch (_) {}
          }
          await stub.fetch(new Request('https://do/end', { method: 'POST' }));
        }
        return json({ ok: true }, 200, H);
      }

      // 6. 콜 상태
      if (url.pathname === '/api/rt/status' && request.method === 'POST') {
        const room = url.searchParams.get('room') || '';
        try {
          const fd = await request.formData();
          // 실제 통화 시간만큼 크레딧에서 깎습니다
          if (String(fd.get('CallStatus')) === 'completed') {
            await cdDeductCall(env, String(fd.get('CallSid') || ''),
                               parseInt(String(fd.get('CallDuration') || '0'), 10) || 0);
          }
          if (room && env.CALL) {
            const stub = env.CALL.get(env.CALL.idFromName(room));
            await stub.fetch(new Request('https://do/callstatus', {
              method: 'POST', body: JSON.stringify({ status: String(fd.get('CallStatus') || '') })
            }));
          }
        } catch (_) {}
        return new Response('OK');
      }

      return new Response('🍇 PodoLang Relay · v7.1 · © BJ LEE', { headers: H });

    } catch (e) {
      return json({ error: e.message || '처리 중 오류가 발생했습니다.' }, 500, H);
    }
  }
};

/* ===================== Durable Object ===================== */

export class CallSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.app = null;      // 내 폰
    this.relay = null;    // Twilio ConversationRelay
    this.me = 'KO';
    this.peer = 'EN';
    this.room = '';
    this.callSid = '';
    this.closed = false;
    this.glossary = '';        // 용어집 (앱 설정에서 옵니다)
    this.tone = 'normal';      // 말투
    this.hist = [];            // 최근 대화. 앞뒤 맥락을 주려고 들고 있습니다
    this.c = { twiml: 0, relayTry: 0, appTry: 0, prompts: 0, saysFromApp: 0,
               toRelay: 0, toApp: 0, lastErr: '', lastRelayEvent: '' };
    // 번역을 한 번에 하나씩만 돌립니다.
    // 두 개가 동시에 흐르면 조각이 뒤섞여 상대가 이상한 말을 듣게 됩니다.

  }

  async fetch(request) {
    const u = new URL(request.url);
    const p = u.pathname;

    if (p === '/config') {
      const b = await request.json();
      this.room = b.room || ''; this.me = up(b.me); this.peer = up(b.peer);
      this.glossary = String(b.glossary || '').slice(0, 4000);
      this.tone = ['formal','normal','casual'].includes(b.tone) ? b.tone : 'normal';
      return json({ ok: true });
    }
    if (p === '/callsid') {
      this.callSid = (await request.json()).callSid || '';
      return json({ ok: true });
    }
    if (p === '/info') {
      return json({ ok: !this.closed, room: this.room, me: this.me, peer: this.peer, callSid: this.callSid });
    }
    if (p === '/bump') { this.c.twiml++; return json({ ok: true }); }
    if (p === '/debug') {
      return json({
        ok: !this.closed, room: this.room, me: this.me, peer: this.peer,
        appUp: !!this.app, relayUp: !!this.relay, callSid: this.callSid,
        말투: this.tone, 용어집줄수: this.glossary ? this.glossary.split(/\n+/).filter(Boolean).length : 0,
        기억한줄: this.hist.length, counters: this.c
      });
    }
    if (p === '/callstatus') {
      const st = String((await request.json()).status || '');
      const dead = {
        'busy':'상대가 통화 중입니다.', 'no-answer':'상대가 받지 않았습니다.',
        'failed':'전화를 연결하지 못했습니다. 번호를 확인해 주세요.',
        'canceled':'통화가 취소되었습니다.', 'completed':'통화가 끝났습니다.'
      };
      const alive = {
        'queued':'전화 거는 중…', 'initiated':'전화 거는 중…',
        'ringing':'상대 전화가 울리고 있습니다…', 'in-progress':'상대가 받았습니다.'
      };
      if (dead[st]) {
        const blocked = !this.relay && (st === 'completed' || st === 'no-answer' || st === 'busy');
        this.toApp({ type: 'callstatus', text: dead[st], ended: true, blocked, raw: st });
        this.shutdown(st);
      } else if (alive[st]) {
        this.toApp({ type: 'callstatus', text: alive[st], ended: false, raw: st });
      }
      return json({ ok: true });
    }
    if (p === '/end') { this.shutdown('요청'); return json({ ok: true }); }

    if (p === '/rt/app') { this.c.appTry++; return this.accept(request, 'app'); }
    if (p.startsWith('/rt/relay')) { this.c.relayTry++; return this.accept(request, 'relay'); }

    return new Response('not found', { status: 404 });
  }

  accept(request, side) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (side === 'app') {
      this.app = server;
      server.addEventListener('message', e => this.onApp(e));
      server.addEventListener('close', () => { this.app = null; });
      this.toApp({ type: 'status', state: 'app-connected' });
      if (this.relay) this.toApp({ type: 'status', state: 'ready' });
    } else {
      this.relay = server;
      server.addEventListener('message', e => this.onRelay(e));
      server.addEventListener('close', () => { this.relay = null; this.shutdown('통화 종료'); });
      this.toApp({ type: 'status', state: 'phone-connected' });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- Twilio → 우리 ---------- */
  async onRelay(ev) {
    let d;
    try { d = JSON.parse(await asText(ev.data)); } catch (_) { return; }
    this.c.lastRelayEvent = d.type || '?';

    if (d.type === 'setup') { this.toApp({ type: 'status', state: 'ready' }); return; }

    // 상대가 말한 것이 글자로 옵니다
    if (d.type === 'prompt') {
      if (d.last === false) return;              // 중간 조각은 건너뜁니다
      const said = String(d.voicePrompt || '').trim();
      if (!said) return;
      this.c.prompts++;
      this.toApp({ type: 'heard', dir: 'peer', text: said });

      try {
        const opt = this.transOpt();
        this.remember('peer', said);
        const mine = await translateStream(this.env, said, this.peer, this.me, piece => {
          this.toApp({ type: 'chunk', dir: 'peer', delta: piece });
          this.c.toApp++;
        }, opt);
        this.toApp({ type: 'line', dir: 'peer', src: said, text: mine });
      } catch (e) {
        this.c.lastErr = '번역 실패: ' + e.message;
        this.toApp({ type: 'error', text: '번역 실패: ' + e.message });
      }
      return;
    }

    if (d.type === 'interrupt') { this.toApp({ type: 'status', state: 'interrupted' }); return; }
    if (d.type === 'error') {
      this.c.lastErr = JSON.stringify(d).slice(0, 300);
      this.toApp({ type: 'error', text: d.description || '통화 오류' });
    }
  }

  /* ---------- 내 폰 → 우리 ---------- */
  async onApp(ev) {
    let d;
    try { d = JSON.parse(await asText(ev.data)); } catch (_) { return; }

    // 내가 한 말(폰에서 이미 글자로 바뀐 것)을 상대 언어로 옮겨 전화에 실어보냅니다
    if (d.type === 'say') {
      const said = String(d.text || '').trim();
      if (!said) return;
      this.c.saysFromApp++;
      try {
        const opt = this.transOpt();
        this.remember('me', said);
        // 조각이 나오는 대로 보내면 Twilio 가 첫 단어부터 바로 말합니다
        const theirs = await translateStream(this.env, said, this.me, this.peer, piece => {
          this.toRelay({ type: 'text', token: piece, last: false });
          this.c.toRelay++;
        }, opt);
        this.toRelay({ type: 'text', token: '', last: true });   // 한 턴 끝
        this.toApp({ type: 'line', dir: 'me', src: said, text: theirs });
      } catch (e) {
        this.c.lastErr = '번역 실패: ' + e.message;
        this.toApp({ type: 'error', text: '번역 실패: ' + e.message });
      }
      return;
    }
    if (d.type === 'bye') this.shutdown('앱 종료');
  }

  // 대화를 기억합니다. 최근 8줄만 들고 있습니다.
  remember(who, src) {
    const s = String(src || '').trim();
    if (!s) return;
    this.hist.push({ who, src: s.slice(0, 200) });
    if (this.hist.length > 8) this.hist = this.hist.slice(-8);
  }
  transOpt() {
    return {
      glossary: this.glossary,
      tone: this.tone,
      context: historyText(this.hist, this.me, this.peer)
    };
  }

  toApp(o) {
    if (this.app && this.app.readyState === 1) {
      try { this.app.send(JSON.stringify(o)); } catch (_) {}
    }
  }
  toRelay(o) {
    if (this.relay && this.relay.readyState === 1) {
      try { this.relay.send(JSON.stringify(o)); } catch (_) {}
    }
  }

  shutdown(why) {
    if (this.closed) return;
    this.closed = true;
    this.toApp({ type: 'status', state: 'ended', why });
    for (const s of [this.relay, this.app]) { try { s && s.close(); } catch (_) {} }
    this.relay = this.app = null;
  }
}

/**
 * Whisper 가 같은 구절을 반복해서 내놓는 경우를 접어냅니다.
 * 거의 무음인 소리를 주면 한 문장을 열 번씩 되풀이하는 알려진 현상입니다.
 */
function dedupeRepeat(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  // 1) 문장 단위로 잇달아 같은 것이 오면 하나만 남깁니다
  const parts = s.split(/(?<=[.!?。？！])\s*/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1] === p) continue;
    out.push(p);
  }
  s = out.join(' ');

  // 2) 문장부호 없이 같은 구절이 세 번 이상 이어지면 하나만 남깁니다
  s = s.replace(/(.{5,80}?)(?:\s*\1){2,}/g, '$1');

  // 3) 그래도 지나치게 길면 자릅니다 (전화 한 마디로는 300자면 충분합니다)
  if (s.length > 300) s = s.slice(0, 300);
  return s.trim();
}

/* ===================== 글자 번역 (게이트웨이 경유) ===================== */

// 말투 지시
const TONE = {
  formal: 'Register: polite and respectful, the way you speak to a client or a senior partner.',
  normal: 'Register: ordinary polite business talk between regular trading partners.',
  casual: 'Register: relaxed and friendly, the way two people who know each other well talk.'
};

function sysPrompt(src, dst, opt) {
  opt = opt || {};
  const s = lname(src), t = lname(dst);
  const lines = [
    `You are a live phone interpreter between two people. Render ONLY the line marked [LINE] from ${s} into ${t}.`,

    // ── 원어민처럼 ──────────────────────────────
    `Do not translate word for word. Say it the way a native ${t} speaker would actually say it`,
    `in this exact situation, out loud, on a phone call. Use the wording, rhythm and softeners`,
    `that native speakers really use. A literal rendering that is grammatically correct but sounds`,
    `foreign is a failure.`,

    // ── 그러나 없는 말은 만들지 않는다 ──────────
    `CRITICAL: never add any fact, promise, date, quantity, reason or offer that was not said.`,
    `This is a business call — an invented delivery date or price becomes a real dispute later.`,
    `Natural wording is required; new information is forbidden. If the speaker was blunt or vague,`,
    `stay blunt or vague — just sound native while doing it.`,

    `Copy numbers, prices, quantities, dates and product codes exactly as spoken.`,
    `Keep it about as long as the original. Do not pad it out.`,
    `Output ONLY the line itself — no quotes, no notes, no romanization, no speaker labels.`,
    `If the line is already in ${t}, repeat it unchanged.`,
    TONE[opt.tone] || TONE.normal
  ];

  // 앞 대화를 보고 "그것", "거기" 같은 말이 무엇인지 알아내라고 시킵니다
  lines.push(
    `Earlier lines are given only as context. Use them to resolve pronouns,`,
    `omitted subjects, and half-finished sentences. Never translate the context itself.`
  );

  // 용어집이 있으면 그대로 쓰게 합니다
  const g = String(opt.glossary || '').trim();
  if (g) {
    lines.push(
      `Always use these fixed translations. They are company terms, partner names and place names:`,
      g.split(/\n+/).map(x => x.trim()).filter(Boolean).slice(0, 80).join(' ; ')
    );
  }
  return lines.join(' ');
}

// 앞 대화를 사람이 읽는 모양으로 만듭니다
function historyText(hist, meLang, peerLang) {
  if (!hist || !hist.length) return '';
  const rows = hist.slice(-6).map(h => {
    const who = h.who === 'me' ? `A(${lname(meLang)})` : `B(${lname(peerLang)})`;
    return `${who}: ${h.src}`;
  });
  return '[CONTEXT — earlier lines, do not translate]\n' + rows.join('\n') + '\n\n';
}

/**
 * 번역을 조각조각 흘려보냅니다.
 * 전체가 끝나기를 기다리지 않아서 체감 지연이 크게 줄어듭니다.
 * onToken(조각) 이 나올 때마다 불리고, 전체 문장을 돌려줍니다.
 */
async function translateStream(env, text, src, dst, onToken, opt) {
  if (!env.OPENAI_API_KEY) throw new Error('OpenAI 키가 없습니다.');
  opt = opt || {};
  const body = (opt.context || '') + '[LINE]\n' + text;
  const res = await fetch(`${OPENAI_HTTP}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      stream: true,
      messages: [
        { role: 'system', content: sysPrompt(src, dst, opt) },
        { role: 'user', content: body }
      ]
    })
  });
  if (!res.ok || !res.body) {
    const b = await res.text().catch(() => '');
    throw new Error(`번역 실패 HTTP ${res.status} ${b.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {          // SSE 는 줄 단위입니다
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const piece = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (piece) { full += piece; onToken(piece); }
      } catch (_) {}
    }
  }
  return full.trim();
}

/* ===================== 유틸 ===================== */

// WebSocket 메시지는 글자로 올 수도, 바이너리로 올 수도 있습니다
async function asText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return await data.text();
  if (data && typeof data.arrayBuffer === 'function') {
    return new TextDecoder().decode(await data.arrayBuffer());
  }
  return String(data);
}

const escXml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));

function cors(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
const xml = body => new Response(body, { headers: { 'Content-Type': 'text/xml' } });
const json = (obj, status = 200, H = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...H } });
