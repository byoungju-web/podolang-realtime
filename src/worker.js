/**
 * 🍇 PODOLANG RELAY — 전화 통역 (Twilio ConversationRelay 방식)
 * Cloudflare Workers + Durable Object · v5.0
 * © 2026 BJ LEE. All Rights Reserved.  (BJ LEE 전용)
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

/* ===================== 이용권 (Cloudflare KV) =====================
   저장 형태
     lic:<CODE>  → 이용권 한 장
     call:<SID>  → 이 통화가 어느 이용권 것인지 (끝날 때 차감하려고)

   ⚠️ 검사는 반드시 워커에서 합니다.
      앱에서 막으면 코드를 고쳐서 그냥 통과합니다.
      API 키가 워커에만 있으니 문은 워커가 지켜야 합니다.                */

// 헷갈리는 글자(0/O, 1/I/L)는 뺐습니다. 전화로 불러줄 수 있어야 합니다.
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newCode() {
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  let a = '', b = '';
  for (let i = 0; i < 4; i++) a += CODE_CHARS[r[i] % CODE_CHARS.length];
  for (let i = 4; i < 8; i++) b += CODE_CHARS[r[i] % CODE_CHARS.length];
  return `PODO-${a}-${b}`;
}
const normCode = c => String(c || '').trim().toUpperCase().replace(/\s/g, '');

async function licGet(env, code) {
  if (!env.LIC) return null;
  return await env.LIC.get('lic:' + normCode(code), 'json');
}
async function licPut(env, code, rec) {
  if (!env.LIC) return;
  await env.LIC.put('lic:' + normCode(code), JSON.stringify(rec));
}

/**
 * 이용권을 확인합니다. 쓸 수 있으면 { ok:true, rec }, 아니면 이유를 돌려줍니다.
 * device 를 주면 기기 수도 함께 검사합니다.
 */
async function licCheck(env, code, device, needMinutes) {
  if (!env.LIC) return { ok: false, reason: '이용권 저장소(KV)가 연결되지 않았습니다.' };
  const c = normCode(code);
  if (!c) return { ok: false, reason: '이용권 코드를 넣어주세요.' };

  const rec = await licGet(env, c);
  if (!rec) return { ok: false, reason: '없는 코드입니다. 다시 확인해 주세요.' };
  if (rec.status !== 'active') return { ok: false, reason: '정지된 이용권입니다.' };

  const now = Date.now();
  if (rec.expiresAt && now > rec.expiresAt) {
    return { ok: false, reason: '이용 기간이 끝났습니다.', rec };
  }

  const left = Math.max(0, (rec.callSecLimit || 0) - (rec.callSecUsed || 0));
  if (needMinutes && left < 60) {
    return { ok: false, reason: '남은 통역 시간이 없습니다. 충전이 필요합니다.', rec };
  }

  // 기기 등록 (한 이용권을 여러 사람이 돌려쓰는 걸 막습니다)
  if (device) {
    rec.devices = rec.devices || [];
    if (!rec.devices.includes(device)) {
      if (rec.devices.length >= (rec.maxDevices || 2)) {
        return { ok: false, reason: `기기 ${rec.maxDevices || 2}대까지만 쓸 수 있습니다.`, rec };
      }
      rec.devices.push(device);
      await licPut(env, c, rec);
    }
  }
  return { ok: true, rec, code: c };
}

function licView(rec) {
  if (!rec) return null;
  const left = Math.max(0, (rec.callSecLimit || 0) - (rec.callSecUsed || 0));
  const days = rec.expiresAt ? Math.ceil((rec.expiresAt - Date.now()) / 86400000) : null;
  return {
    plan: rec.plan || '개인',
    status: rec.status,
    남은분: Math.floor(left / 60),
    쓴분: Math.floor((rec.callSecUsed || 0) / 60),
    만료일: rec.expiresAt ? new Date(rec.expiresAt).toISOString().slice(0, 10) : '무기한',
    남은일수: days,
    기기: (rec.devices || []).length + ' / ' + (rec.maxDevices || 2)
  };
}

// 통화가 끝나면 쓴 시간만큼 깎습니다. Twilio 는 분 단위로 과금하니 올림합니다.
async function licDeduct(env, callSid, seconds) {
  if (!env.LIC || !callSid) return;
  const code = await env.LIC.get('call:' + callSid);
  if (!code) return;
  const rec = await licGet(env, code);
  if (!rec) return;
  const charge = Math.ceil(Math.max(0, seconds) / 60) * 60;
  rec.callSecUsed = (rec.callSecUsed || 0) + charge;
  rec.lastCallAt = Date.now();
  await licPut(env, code, rec);
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
          ok: true, app: 'podolang-relay', version: '6.0',
          mode: 'Twilio ConversationRelay — 음성은 Twilio, 번역만 워커',
          translateModel: TRANSLATE_MODEL,
          keys: {
            openai: !!env.OPENAI_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
            durableObject: !!env.CALL,
            licenseStore: !!env.LIC,
            adminKey: !!env.ADMIN_KEY
          }
        }, 200, H);
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

      // ---- 이용권 확인 (앱이 남은 시간을 보여줄 때 씁니다) ----
      if (url.pathname === '/api/lic/check' && request.method === 'POST') {
        const b = await request.json();
        const r = await licCheck(env, b.code, b.device, false);
        return json(r.ok
          ? { ok: true, ...licView(r.rec) }
          : { ok: false, reason: r.reason, ...(r.rec ? licView(r.rec) : {}) }, 200, H);
      }

      // ---- 이용권 발급 (사장님만) ----
      //  POST /api/lic/issue
      //  { adminKey, plan:'개인'|'비즈니스', days:365, minutes:0, maxDevices:2, memo:'홍길동 카톡' }
      if (url.pathname === '/api/lic/issue' && request.method === 'POST') {
        const b = await request.json();
        if (!env.ADMIN_KEY || b.adminKey !== env.ADMIN_KEY) {
          return json({ error: '권한이 없습니다.' }, 403, H);
        }
        if (!env.LIC) return json({ error: 'KV(LIC)가 연결되지 않았습니다.' }, 400, H);
        const days = Number(b.days) > 0 ? Number(b.days) : 365;
        const mins = Number(b.minutes) >= 0 ? Number(b.minutes) : 0;
        const code = newCode();
        const rec = {
          plan: b.plan || '개인',
          status: 'active',
          issuedAt: Date.now(),
          expiresAt: Date.now() + days * 86400000,
          callSecLimit: mins * 60,
          callSecUsed: 0,
          maxDevices: Number(b.maxDevices) > 0 ? Number(b.maxDevices) : 2,
          devices: [],
          memo: String(b.memo || '')
        };
        await licPut(env, code, rec);
        return json({ ok: true, code, ...licView(rec), memo: rec.memo }, 200, H);
      }

      // ---- 통역 시간 충전 / 기간 연장 (사장님만) ----
      if (url.pathname === '/api/lic/topup' && request.method === 'POST') {
        const b = await request.json();
        if (!env.ADMIN_KEY || b.adminKey !== env.ADMIN_KEY) {
          return json({ error: '권한이 없습니다.' }, 403, H);
        }
        const c = normCode(b.code);
        const rec = await licGet(env, c);
        if (!rec) return json({ error: '없는 코드입니다.' }, 404, H);
        if (Number(b.addMinutes)) rec.callSecLimit = (rec.callSecLimit || 0) + Number(b.addMinutes) * 60;
        if (Number(b.addDays))    rec.expiresAt = Math.max(Date.now(), rec.expiresAt || Date.now()) + Number(b.addDays) * 86400000;
        if (b.status) rec.status = b.status;
        if (b.resetDevices) rec.devices = [];
        await licPut(env, c, rec);
        return json({ ok: true, code: c, ...licView(rec), memo: rec.memo }, 200, H);
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

        // ⚠️ 여기가 문입니다. 이용권이 없으면 전화가 나가지 않습니다.
        const lic = await licCheck(env, body.code, body.device, true);
        if (!lic.ok) {
          return json({ error: lic.reason, needLicense: true }, 402, H);
        }

        const me = up(myLang || 'KO'), peer = up(peerLang || 'EN');

        const room = crypto.randomUUID().slice(0, 12);
        const stub = env.CALL.get(env.CALL.idFromName(room));
        await stub.fetch(new Request('https://do/config', {
          method: 'POST', body: JSON.stringify({ room, me, peer })
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
        // 통화가 끝날 때 어느 이용권에서 깎을지 적어둡니다 (12시간 뒤 자동 삭제)
        try{ await env.LIC.put('call:' + d.sid, lic.code, { expirationTtl: 43200 }); }catch(_){}

        return json({
          ok: true, room, callSid: d.sid,
          이용권: licView(lic.rec),
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
      interruptible="none"
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
          // 실제 통화 시간만큼 이용권에서 깎습니다
          if (String(fd.get('CallStatus')) === 'completed') {
            await licDeduct(env, String(fd.get('CallSid') || ''),
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

      return new Response('🍇 PodoLang Relay · v5.0 · © BJ LEE', { headers: H });

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
    this.c = { twiml: 0, relayTry: 0, appTry: 0, prompts: 0, saysFromApp: 0,
               toRelay: 0, toApp: 0, queued: 0, lastErr: '', lastRelayEvent: '' };
    // 번역을 한 번에 하나씩만 돌립니다.
    // 두 개가 동시에 흐르면 조각이 뒤섞여 상대가 이상한 말을 듣게 됩니다.
    this.sayChain = Promise.resolve();
  }

  async fetch(request) {
    const u = new URL(request.url);
    const p = u.pathname;

    if (p === '/config') {
      const b = await request.json();
      this.room = b.room || ''; this.me = up(b.me); this.peer = up(b.peer);
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
        appUp: !!this.app, relayUp: !!this.relay, callSid: this.callSid, counters: this.c
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
        const mine = await translateStream(this.env, said, this.peer, this.me, piece => {
          this.toApp({ type: 'chunk', dir: 'peer', delta: piece });
          this.c.toApp++;
        });
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
      this.c.queued++;
      // 앞의 번역이 끝난 뒤에 시작합니다 (조각이 뒤섞이지 않게)
      this.sayChain = this.sayChain.then(() => this.sendOneSay(said)).catch(() => {});
      return;
    }
    if (d.type === 'bye') this.shutdown('앱 종료');
  }

  // 한 문장을 상대에게 보냅니다. 조각이 나오는 대로 흘려서 Twilio 가 바로 말하게 합니다.
  async sendOneSay(said) {
    try {
      const theirs = await translateStream(this.env, said, this.me, this.peer, piece => {
        this.toRelay({ type: 'text', token: piece, last: false });
        this.c.toRelay++;
      });
      this.toRelay({ type: 'text', token: '', last: true });   // 한 턴 끝
      this.toApp({ type: 'line', dir: 'me', src: said, text: theirs });
    } catch (e) {
      this.c.lastErr = '번역 실패: ' + e.message;
      this.toApp({ type: 'error', text: '번역 실패: ' + e.message });
    } finally {
      this.c.queued = Math.max(0, this.c.queued - 1);
    }
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

/* ===================== 글자 번역 (게이트웨이 경유) ===================== */

function sysPrompt(src, dst) {
  const s = lname(src), t = lname(dst);
  return [
    `You are a phone interpreter. Translate the user's line from ${s} into ${t}.`,
    `Output ONLY the translation. No quotes, no notes, no romanization, no explanation.`,
    `This is live business speech, so keep it natural and spoken, not literary.`,
    `Copy numbers, prices, quantities, dates and product codes exactly.`,
    `Keep the speaker's level of politeness.`,
    `If the line is already in ${t}, repeat it unchanged.`
  ].join(' ');
}

async function translateText(env, text, src, dst) {
  if (!env.OPENAI_API_KEY) throw new Error('OpenAI 키가 없습니다.');

  const res = await fetch(`${OPENAI_HTTP}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [{ role: 'system', content: sysPrompt(src, dst) }, { role: 'user', content: text }]
    })
  });
  const raw = await res.text();
  let d;
  try { d = JSON.parse(raw); }
  catch (_) { throw new Error('번역 응답을 읽지 못했습니다: ' + raw.slice(0, 200)); }
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error).slice(0, 200));
  const out = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!out) throw new Error('번역 결과가 비었습니다.');
  return out.trim();
}

/**
 * 번역을 조각조각 흘려보냅니다.
 * 전체가 끝나기를 기다리지 않아서 체감 지연이 크게 줄어듭니다.
 * onToken(조각) 이 나올 때마다 불리고, 전체 문장을 돌려줍니다.
 */
async function translateStream(env, text, src, dst, onToken) {
  if (!env.OPENAI_API_KEY) throw new Error('OpenAI 키가 없습니다.');
  const res = await fetch(`${OPENAI_HTTP}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      stream: true,
      messages: [
        { role: 'system', content: sysPrompt(src, dst) },
        { role: 'user', content: text }
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
