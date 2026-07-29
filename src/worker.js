/**
 * 🍇 PODOLANG REALTIME — Full-Duplex 전화 통역
 * Cloudflare Workers + Durable Object · v2.0
 * © 2026 BJ LEE. All Rights Reserved.  (BJ LEE 전용)
 *
 * 구조 (양쪽이 동시에 말하고 동시에 들림)
 *
 *   [내 폰 브라우저]  --WS(PCM16 24k)-->  [Durable Object]  --WS-->  [OpenAI 통역세션 A]
 *                                              |                        (출력=상대 언어)
 *                                              |                              |
 *                                              +--------- μ-law 8k ----------+
 *                                              |
 *                                              v
 *                                       [Twilio Media Stream] --> 상대 전화
 *
 *   상대 전화 --> Twilio(μ-law 8k) --> DO --> [OpenAI 통역세션 B] --> 내 폰 (출력=내 언어)
 *
 * 두 방향이 완전히 독립된 세션이라 동시에 말해도 서로 막지 않습니다 = Full-Duplex.
 *
 * 태국어 예외
 *   gpt-realtime-translate 의 출력 언어 13개에 태국어가 없습니다.
 *   → 상대(태국어) → 나(한국어) 방향은 실시간 그대로 작동
 *   → 나(한국어) → 상대(태국어) 방향만 체인 방식으로 처리 (/api/rt/say)
 *     Whisper → GPT → ElevenLabs(ulaw_8000) → 통화에 바로 주입
 */

/* ===================== 설정 ===================== */

const RT_MODEL_NOTE = 'gpt-realtime-translate';

// OpenAI 실시간 통역 소켓 주소 두 가지.
// 지역차단이 나면 게이트웨이 쪽으로 갈아탑니다.
// wrangler.toml 의 [vars] 에 RT_MODE = "gateway" 를 넣으면 바뀝니다.
// ⚠️ Workers 의 fetch() 는 wss:// 를 받지 않습니다. https:// 로 쓰고
//    Upgrade: websocket 헤더를 붙이면 런타임이 알아서 업그레이드합니다.
const RT_DIRECT  = 'https://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
// 게이트웨이 이름은 CF_AIG_GATEWAY 로 바꿀 수 있습니다 (기본 podolang-rt)
const gwBase = env => `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${(env && env.CF_AIG_GATEWAY) || 'podolang-rt'}/openai`;
// ① 문서에 나온 형태 — OpenAI 의 /v1/realtime 으로 연결됩니다
const gwUrl     = env => `${gwBase(env)}?model=gpt-realtime-translate`;
// ② 경로를 그대로 넘기는 형태 — /v1/realtime/translations 로 연결되기를 기대합니다
const gwUrlPath = env => `${gwBase(env)}/v1/realtime/translations?model=gpt-realtime-translate`;
// wrangler.toml 의 [vars] 에 RT_MODE 를 넣어 갈아탑니다.
//   "gateway"     → ①   "gatewaypath" → ②   없으면 직접연결
const rtUrl = env => {
  const m = env && env.RT_MODE;
  if (m === 'gateway') return gwUrl(env);
  if (m === 'gatewaypath') return gwUrlPath(env);
  return RT_DIRECT;
};
// 게이트웨이로 갈 때는 cf-aig-authorization 토큰이 있어야 합니다.
// 없으면 게이트웨이가 401 Unauthorized 로 막습니다.
function aigHeaders(env, url, style) {
  const h = { Upgrade: 'websocket', Authorization: `Bearer ${env.OPENAI_API_KEY}` };
  if (String(url).includes('gateway.ai.cloudflare.com') && env.CF_AIG_TOKEN) {
    // 문서마다 Bearer 를 붙이는 예와 안 붙이는 예가 섞여 있어 둘 다 지원합니다
    h['cf-aig-authorization'] = (style === 'bare')
      ? env.CF_AIG_TOKEN
      : `Bearer ${env.CF_AIG_TOKEN}`;
  }
  return h;
}

// 체인 폴백(태국어 등)에 쓰는 기존 파이프라인 — 지역차단 우회를 위해 게이트웨이 경유
const CF_ACCOUNT_ID = '8e3361d320715cc98e7b66cb3127ca76';
const CF_GATEWAY = 'podolang';
const OPENAI_HTTP = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY}/openai`;

// gpt-realtime-translate 가 "소리로 내보낼 수 있는" 13개 언어 (소문자 ISO-639-1)
const RT_OUT = ['es','pt','fr','ja','ru','zh','de','ko','hi','id','vi','it','en'];

// 체인 폴백에서 쓸 ElevenLabs 목소리 (Sarah)
const VOICE_DEFAULT = 'EXAVITQu4vr4xnSDxMaL';

const ALLOWED = [
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://byoungju-web.github.io',
  'http://localhost:8788'
];

const LC = { KO:'ko', TH:'th', EN:'en', JA:'ja', ZH:'zh', VI:'vi', ES:'es', ID:'id',
             DE:'de', FR:'fr', AR:'ar', IT:'it', RU:'ru', PT:'pt', HI:'hi' };
const lc = v => LC[String(v||'').toUpperCase()] || String(v||'en').toLowerCase();
const rtOk = v => RT_OUT.includes(lc(v));

/* ===================== Worker 진입점 ===================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const H = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: H });

    try {
      // 상태 확인
      if (url.pathname === '/api/rt/health') {
        return json({
          ok: true, app: 'podolang-realtime', version: '3.2',
          model: RT_MODEL_NOTE,
          realtimeOutputLangs: RT_OUT,
          keys: {
            openai: !!env.OPENAI_API_KEY,
            elevenlabs: !!env.ELEVENLABS_API_KEY,
            twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
            durableObject: !!env.CALL,
            aigToken: !!env.CF_AIG_TOKEN,
            aigGateway: env.CF_AIG_GATEWAY || '(기본 podolang-rt)',
            rtMode: env.RT_MODE || '(직접연결)'
          }
        }, 200, H);
      }

      // 전화를 걸지 않고 OpenAI 통역 소켓만 시험합니다.
      // 브라우저로 그냥 열면 됩니다: /api/rt/testopenai
      if (url.pathname === '/api/rt/testopenai') {
        const results = {};
        const B = gwBase(env);
        const L = { listenOnly: true };   // 아무것도 안 보내고 듣기만

        // ① 통역 전용 모델 — 우리가 원하는 것
        results['A_통역모델_듣기만'] =
          await probeRealtime(env, `${B}?model=gpt-realtime-translate`, 'bearer', L);
        results['B_통역모델_경로_듣기만'] =
          await probeRealtime(env, `${B}/v1/realtime/translations?model=gpt-realtime-translate`, 'bearer', L);

        // ② 게이트웨이가 문서상 지원하는 일반 실시간 모델 — 이게 되면 대안이 생깁니다
        results['C_일반실시간_듣기만'] =
          await probeRealtime(env, `${B}?model=gpt-realtime`, 'bearer', L);
        results['D_구형실시간_듣기만'] =
          await probeRealtime(env, `${B}?model=gpt-4o-realtime-preview`, 'bearer', L);

        // ③ 비교용: 보내기까지 하는 기존 방식
        if (url.searchParams.get('all') === '1') {
          results['E_통역모델_보내기'] =
            await probeRealtime(env, `${B}?model=gpt-realtime-translate`, 'bearer');
          results['F_직접연결'] = await probeRealtime(env, RT_DIRECT, null, L);
        }
        return json({
          ok: true,
          nowUsing: (env.RT_MODE === 'gateway') ? 'gateway' : 'direct',
          model: RT_MODEL_NOTE,
          hasKey: !!env.OPENAI_API_KEY,
          results,
           도움말: 'ok:true 이고 firstMessage 에 session 관련 내용이 오면 그 경로가 쓸 수 있는 것입니다.'
        }, 200, H);
      }

      // 언어 조합 미리 확인 — 앱이 "실시간 되는지"를 먼저 물어봅니다
      if (url.pathname === '/api/rt/check') {
        const me = lc(url.searchParams.get('me') || 'ko');
        const peer = lc(url.searchParams.get('peer') || 'en');
        return json({
          ok: true,
          peerToMe: rtOk(me) ? 'realtime' : 'unsupported',
          meToPeer: rtOk(peer) ? 'realtime' : 'chained',
          note: rtOk(peer) ? '양방향 실시간입니다.'
                           : '상대 말은 실시간으로 들리고, 내 말은 2초쯤 뒤에 전달됩니다.'
        }, 200, H);
      }

      // 1. 통화 시작 — 상대에게 전화를 겁니다
      if (url.pathname === '/api/rt/start' && request.method === 'POST') {
        if (!env.CALL) return json({ error: 'Durable Object(CALL)가 연결되지 않았습니다.' }, 400, H);
        if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER) {
          return json({ error: 'Twilio 설정이 없습니다.' }, 400, H);
        }
        const { to, myLang, peerLang } = await request.json();
        if (!/^\+\d{8,15}$/.test(to || '')) {
          return json({ error: '전화번호는 +82… 처럼 국가번호부터 넣어주세요.' }, 400, H);
        }
        const me = lc(myLang || 'ko'), peer = lc(peerLang || 'en');
        if (!rtOk(me)) {
          return json({ error: `내 언어(${me})는 실시간 통역이 지원하지 않습니다. 지원: ${RT_OUT.join(', ')}` }, 400, H);
        }

        // 방(room) 하나가 통화 하나. Durable Object 인스턴스를 이 이름으로 잡습니다.
        const room = crypto.randomUUID().slice(0, 12);
        const stub = env.CALL.get(env.CALL.idFromName(room));

        // 언어와 방 정보를 먼저 넣어둡니다 (Twilio가 붙기 전에)
        await stub.fetch(new Request('https://do/config', {
          method: 'POST',
          body: JSON.stringify({ room, me, peer, mode: rtOk(peer) ? 'realtime' : 'chained' })
        }));

        // Twilio 아웃바운드 콜
        const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
        const form = new URLSearchParams();
        form.append('To', to);
        form.append('From', env.TWILIO_PHONE_NUMBER);
        form.append('Url', `${url.origin}/twiml/rt?room=${room}&peer=${peer}`);
        form.append('StatusCallback', `${url.origin}/api/rt/status?room=${room}`);
        // 울림 · 받음 · 종료를 모두 받아야 앱이 "안 받았다"를 알 수 있습니다
        form.append('StatusCallbackEvent', 'initiated');
        form.append('StatusCallbackEvent', 'ringing');
        form.append('StatusCallbackEvent', 'answered');
        form.append('StatusCallbackEvent', 'completed');
        // 벨이 25초 넘게 울리면 끊습니다 (음성사서함으로 넘어가는 걸 막습니다)
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

        return json({
          ok: true, room, callSid: d.sid,
          wsUrl: `${url.origin.replace(/^http/, 'ws')}/rt/app?room=${room}`,
          mode: rtOk(peer) ? 'realtime' : 'chained',
          message: `${to} 로 거는 중입니다.`
        }, 200, H);
      }

      // 2. Twilio가 상대 전화를 연결하면 호출하는 TwiML
      //    <Connect><Stream> 은 통화를 점유하는 종결 verb 입니다.
      //    뒤에 <Dial> 같은 걸 붙이면 실행되지 않으니 넣지 마세요.
      if (url.pathname === '/twiml/rt') {
        const room = url.searchParams.get('room') || '';
        // Twilio 가 TwiML 을 읽어갔다는 사실을 기록합니다
        if (room && env.CALL) {
          try {
            const stub = env.CALL.get(env.CALL.idFromName(room));
            await stub.fetch(new Request('https://do/bump?k=twiml', { method: 'POST' }));
          } catch (_) {}
        }
        // ⚠️ <Stream> 의 url 에는 쿼리 문자열(?room=...)을 쓸 수 없습니다.
        //    쓰면 Twilio 가 handshake 단계에서 거부합니다 (에러 31920).
        //    그래서 방번호를 경로에 넣습니다. 부가 정보는 <Parameter> 로 넘깁니다.
        const ws = `${url.origin.replace(/^http/, 'ws')}/rt/twilio/${encodeURIComponent(room)}`;
        const cb = `${url.origin}/api/rt/streamstatus?room=${encodeURIComponent(room)}`;
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escXml(ws)}" statusCallback="${escXml(cb)}">
      <Parameter name="room" value="${escXml(room)}"/>
    </Stream>
  </Connect>
</Response>`);
      }

      // 3. WebSocket 두 갈래 — 둘 다 같은 Durable Object 로 넘깁니다
      if (url.pathname === '/rt/app' || url.pathname.startsWith('/rt/twilio')) {
        // 대소문자를 가리지 않습니다. Twilio 는 'WebSocket' 처럼 보낼 수 있습니다.
        const up = (request.headers.get('Upgrade') || '').toLowerCase();
        if (up !== 'websocket') {
          return new Response('WebSocket 연결이 필요합니다.', { status: 426 });
        }
        // 앱은 ?room= 로, Twilio 는 경로 /rt/twilio/<room> 으로 옵니다
        let room = url.searchParams.get('room') || '';
        if (!room && url.pathname.startsWith('/rt/twilio/')) {
          room = decodeURIComponent(url.pathname.slice('/rt/twilio/'.length));
        }
        if (!room) return new Response('room 없음', { status: 400 });
        const stub = env.CALL.get(env.CALL.idFromName(room));
        // 원본 요청을 그대로 넘깁니다.
        // new Request(url, request) 로 다시 만들면 업그레이드가 깨질 수 있습니다.
        return stub.fetch(request);
      }

      // Twilio 가 스트림 상태를 알려주는 곳 (실패 원인이 여기 남습니다)
      if (url.pathname === '/api/rt/streamstatus' && request.method === 'POST') {
        const room = url.searchParams.get('room') || '';
        try {
          const fd = await request.formData();
          const info = {
            event: String(fd.get('StreamEvent') || ''),
            error: String(fd.get('StreamError') || ''),
            sid: String(fd.get('StreamSid') || '')
          };
          if (room && env.CALL) {
            const stub = env.CALL.get(env.CALL.idFromName(room));
            await stub.fetch(new Request('https://do/streamstatus', {
              method: 'POST', body: JSON.stringify(info)
            }));
          }
        } catch (_) {}
        return new Response('OK');
      }

      // 4. 체인 폴백 — 실시간이 안 되는 언어(태국어 등)로 내 말을 보낼 때
      if (url.pathname === '/api/rt/say' && request.method === 'POST') {
        const fd = await request.formData();
        const room = String(fd.get('room') || '');
        const audio = fd.get('audio');
        if (!room) return json({ error: 'room 없음' }, 400, H);

        const stub = env.CALL.get(env.CALL.idFromName(room));
        const infoRes = await stub.fetch(new Request('https://do/info'));
        const info = await infoRes.json();
        if (!info.ok) return json({ error: '통화를 찾을 수 없습니다.' }, 404, H);

        // 내 말 → 텍스트 → 상대 언어 → μ-law 8k 음성
        const said = await transcribe(env, audio, info.me);
        if (!said || !said.trim()) return json({ error: '음성을 인식하지 못했습니다.' }, 400, H);
        const translated = await translateText(env, said, info.me, info.peer);
        const ulaw = await ttsUlaw(env, translated, info.peer);

        // Durable Object 를 통해 통화에 밀어넣습니다
        await stub.fetch(new Request('https://do/inject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: ulaw
        }));

        return json({ ok: true, src: said, translated }, 200, H);
      }

      // 4-1. 진단 — 통화 중에 브라우저로 열어서 어디서 끊기는지 봅니다
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
          const r = await stub.fetch(new Request('https://do/info'));
          const info = await r.json();
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

      // 6. Twilio 콜 상태 콜백 — 앱에 그대로 전달합니다
      if (url.pathname === '/api/rt/status' && request.method === 'POST') {
        const room = url.searchParams.get('room') || '';
        try {
          const fd = await request.formData();
          const st = String(fd.get('CallStatus') || '');
          if (room && env.CALL) {
            const stub = env.CALL.get(env.CALL.idFromName(room));
            await stub.fetch(new Request('https://do/callstatus', {
              method: 'POST', body: JSON.stringify({ status: st })
            }));
          }
        } catch (_) {}
        return new Response('OK');
      }

      return new Response('🍇 PodoLang Realtime · v2.0 · © BJ LEE', { headers: H });

    } catch (e) {
      return json({ error: e.message || '처리 중 오류가 발생했습니다.' }, 500, H);
    }
  }
};

/* ===================== Durable Object: 통화 하나 = 인스턴스 하나 ===================== */

export class CallSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.app = null;        // 내 폰 브라우저 소켓
    this.twilio = null;     // Twilio Media Stream 소켓
    this.streamSid = null;

    this.me = 'ko';         // 내 언어
    this.peer = 'en';       // 상대 언어
    this.mode = 'realtime'; // realtime | chained (내 말 → 상대 방향)
    this.room = '';
    this.callSid = '';

    this.sessMe = null;     // OpenAI 세션: 상대 말 → 내 언어
    this.sessPeer = null;   // OpenAI 세션: 내 말 → 상대 언어
    this.closed = false;

    // 상대에게 나갈 μ-law 프레임 큐 (20ms = 160바이트씩 흘려보냄)
    this.outQueue = [];
    this.pump = null;

    // 어디서 끊기는지 보려고 세는 값들 (/api/rt/debug?room= 에서 확인)
    this.c = {
      twStart: 0, twMedia: 0, twOther: 0, twBytes: 0,
      tracks: {},                 // Twilio 가 어떤 track 을 보내는지
      toSessMe: 0, toSessMeBytes: 0,
      meAudioDelta: 0, meTextDelta: 0,
      peerAudioDelta: 0, peerTextDelta: 0,
      toPeerFrames: 0, sentToTwilio: 0,
      lastErr: '', lastEvent: ''
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/config') {
      const b = await request.json();
      this.room = b.room || '';
      this.me = b.me || 'ko';
      this.peer = b.peer || 'en';
      this.mode = b.mode || 'realtime';
      return json({ ok: true });
    }
    if (p === '/callsid') {
      const b = await request.json();
      this.callSid = b.callSid || '';
      return json({ ok: true });
    }
    if (p === '/info') {
      return json({
        ok: !this.closed, room: this.room, me: this.me, peer: this.peer,
        mode: this.mode, callSid: this.callSid,
        appUp: !!this.app, phoneUp: !!this.twilio
      });
    }
    if (p === '/inject') {
      // 체인 폴백으로 만든 μ-law 음성을 통화에 밀어넣습니다
      const buf = new Uint8Array(await request.arrayBuffer());
      this.enqueueToPeer(buf);
      return json({ ok: true, bytes: buf.length });
    }
    if (p === '/streamstatus') {
      const b = await request.json();
      this.c.streamEvent = b.event || '';
      if (b.error) this.c.streamError = b.error;
      if (b.event === 'stream-error' || b.error) {
        this.toApp({ type: 'error', text: '통화 음성 연결 실패: ' + (b.error || b.event) });
      }
      return json({ ok: true });
    }
    if (p === '/bump') {
      const k = url.searchParams.get('k') || 'x';
      if (k === 'twiml') this.c.twimlHits = (this.c.twimlHits || 0) + 1;
      return json({ ok: true });
    }
    if (p === '/callstatus') {
      const b = await request.json();
      const st = String(b.status || '');
      // 끝난 것으로 봐야 하는 상태들
      const dead = {
        'busy':      '상대가 통화 중입니다.',
        'no-answer': '상대가 받지 않았습니다.',
        'failed':    '전화를 연결하지 못했습니다. 번호를 확인해 주세요.',
        'canceled':  '통화가 취소되었습니다.',
        'completed': '통화가 끝났습니다.'
      };
      const alive = {
        'queued':      '전화 거는 중…',
        'initiated':   '전화 거는 중…',
        'ringing':     '상대 전화가 울리고 있습니다…',
        'in-progress': '상대가 받았습니다. 통역 준비 중…'
      };
      if (dead[st]) {
        // 상대가 한 번도 안 받았는데 끝났으면 차단/스팸필터일 가능성이 큽니다
        const blocked = !this.twilio && (st === 'completed' || st === 'no-answer' || st === 'busy');
        this.toApp({ type: 'callstatus', text: dead[st], ended: true, blocked, raw: st });
        this.shutdown(st);
      } else if (alive[st]) {
        this.toApp({ type: 'callstatus', text: alive[st], ended: false, raw: st });
      }
      return json({ ok: true });
    }
    if (p === '/debug') {
      const st = w => w ? w.readyState : -1;   // 1 = 열림
      return json({
        ok: !this.closed, room: this.room, me: this.me, peer: this.peer, mode: this.mode,
        appUp: !!this.app, phoneUp: !!this.twilio, streamSid: this.streamSid || null,
        sessMeState: st(this.sessMe), sessPeerState: st(this.sessPeer),
        counters: this.c, queued: this.outQueue.length
      });
    }
    if (p === '/end') { this.shutdown('요청'); return json({ ok: true }); }

    // 워커가 원본 요청을 그대로 넘기므로 실제 경로로 들어옵니다
    if (p === '/rt/app' || p === '/ws/app') {
      this.c.wsAppTry = (this.c.wsAppTry||0)+1;
      return this.accept(request, 'app');
    }
    if (p === '/ws/twilio' || p === '/rt/twilio' || p.startsWith('/rt/twilio/')) {
      this.c.wsTwilioTry = (this.c.wsTwilioTry||0)+1;
      return this.accept(request, 'twilio');
    }

    return new Response('not found', { status: 404 });
  }

  accept(request, side) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (side === 'app') {
      this.app = server;
      server.addEventListener('message', e => this.onAppMessage(e));
      server.addEventListener('close', () => { this.app = null; this.shutdown('앱 종료'); });
      server.addEventListener('error', () => { this.app = null; });
      this.toApp({ type: 'status', state: 'app-connected', mode: this.mode });
    } else {
      this.twilio = server;
      server.addEventListener('message', e => this.onTwilioMessage(e));
      server.addEventListener('close', () => { this.twilio = null; this.shutdown('통화 종료'); });
      server.addEventListener('error', () => { this.twilio = null; });
    }

    this.maybeStart();
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- 두 다리가 다 붙으면 OpenAI 통역 세션을 엽니다 ---------- */
  async maybeStart() {
    if (!this.app || !this.twilio) return;
    if (this.sessMe || this.sessPeer) return;

    // 방향 1: 상대 말 → 내 언어 (항상 실시간)
    this.sessMe = await this.openTranslate(this.me, 'peer→me');
    // 방향 2: 내 말 → 상대 언어 (상대 언어가 지원될 때만 실시간)
    if (this.mode === 'realtime') {
      this.sessPeer = await this.openTranslate(this.peer, 'me→peer');
    }
    this.startPump();
    this.toApp({ type: 'status', state: 'ready', mode: this.mode });
  }

  /**
   * OpenAI 통역 세션 열기.
   * Workers 에서는 new WebSocket(url,{headers}) 로 헤더를 못 붙입니다.
   * fetch 에 Upgrade 헤더를 실어 보내고 응답의 webSocket 을 accept() 해야 합니다.
   */
  async openTranslate(outLang, tag) {
    try {
      // ⚠️ 'OpenAI-Beta: realtime=v1' 를 붙이면 안 됩니다.
      //    옛 베타 규격으로 취급돼서 beta_api_shape_disabled 로 거부당합니다.
      const u = String(rtUrl(this.env)).replace(/^wss:/, 'https:');
      let res = await fetch(u, { headers: aigHeaders(this.env, u, 'bearer') });
      // Bearer 형식이 거부되면 토큰만 그대로 보내는 형식으로 한 번 더
      if (!res.webSocket && res.status === 401 && u.includes('gateway.ai.cloudflare.com')) {
        res = await fetch(u, { headers: aigHeaders(this.env, u, 'bare') });
      }
      const ws = res.webSocket;
      if (!ws) {
        // 실패 이유를 남깁니다. 예전엔 조용히 넘어가서 원인을 못 봤습니다.
        let body = '';
        try { body = (await res.text()).slice(0, 300); } catch (_) {}
        this.c.lastErr = `[${tag}] 세션 열기 실패 HTTP ${res.status} ${body}`;
        this.toApp({ type: 'error', text: `통역 세션 연결 실패 (HTTP ${res.status})` });
        return null;
      }
      ws.accept();

      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              noise_reduction: { type: 'near_field' }
            },
            output: { language: outLang }
          }
        }
      }));

      ws.addEventListener('message', ev => this.onModelMessage(ev, tag));
      ws.addEventListener('close', () => this.toApp({ type: 'status', state: `closed:${tag}` }));
      ws.addEventListener('error', () => this.toApp({ type: 'error', text: `통역 세션 오류 (${tag})` }));
      return ws;
    } catch (e) {
      this.c.lastErr = `[${tag}] 예외 ${e.message}`;
      this.toApp({ type: 'error', text: `통역 세션 예외 (${tag}): ${e.message}` });
      return null;
    }
  }

  /* ---------- OpenAI → 우리 ---------- */
  onModelMessage(ev, tag) {
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }

    // 번역된 음성 (base64 PCM16 24kHz, 200ms 단위)
    if (d.type === 'session.output_audio.delta' && d.delta) {
      if (tag === 'me→peer') this.c.peerAudioDelta++; else this.c.meAudioDelta++;
      const pcm24 = b64ToI16(d.delta);
      if (tag === 'me→peer') {
        // 내 말이 상대 언어로 번역됨 → 전화로
        this.enqueueToPeer(i16ToUlaw(down24to8(pcm24)));
      } else {
        // 상대 말이 내 언어로 번역됨 → 내 폰으로 (PCM16 24k 그대로)
        this.toApp({ type: 'audio', audio: d.delta });
      }
      return;
    }

    // 번역문 자막
    if (d.type === 'session.output_transcript.delta' && d.delta) {
      if (tag === 'me→peer') this.c.peerTextDelta++; else this.c.meTextDelta++;
      this.toApp({ type: 'text', dir: tag === 'me→peer' ? 'me' : 'peer', delta: d.delta });
      return;
    }
    if (d.type === 'session.output_transcript.done') {
      this.toApp({ type: 'text_done', dir: tag === 'me→peer' ? 'me' : 'peer' });
      return;
    }
    if (d.type === 'error') {
      const msg = (d.error && d.error.message) || JSON.stringify(d).slice(0, 200);
      this.c.lastErr = `[${tag}] ${msg}`;
      this.toApp({ type: 'error', text: msg });
    }
  }

  /* ---------- 내 폰 → 우리 ---------- */
  onAppMessage(ev) {
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }

    if (d.type === 'audio' && d.audio) {
      // 브라우저가 보낸 PCM16 24kHz 를 그대로 통역 세션에 흘려보냅니다.
      // 조용한 구간도 계속 보내야 합니다 — 턴 방식이 아니라서 끊으면 맥락이 깨집니다.
      if (this.sessPeer && this.sessPeer.readyState === 1) {
        this.sessPeer.send(JSON.stringify({
          type: 'session.input_audio_buffer.append',
          audio: d.audio
        }));
        this.c.fromApp = (this.c.fromApp || 0) + 1;
      }
      return;
    }
    if (d.type === 'bye') this.shutdown('앱 종료 요청');
  }

  /* ---------- Twilio → 우리 ---------- */
  onTwilioMessage(ev) {
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }

    this.c.lastEvent = d.event || '?';

    if (d.event === 'start') {
      this.c.twStart++;
      this.streamSid = d.start && d.start.streamSid;
      // <Parameter> 로 넘긴 값이 여기 들어옵니다
      const cp = d.start && d.start.customParameters;
      if (cp && cp.room && !this.room) this.room = cp.room;
      this.toApp({ type: 'status', state: 'phone-connected' });
      return;
    }
    if (d.event === 'media' && d.media && d.media.payload) {
      this.c.twMedia++;
      const tr = d.media.track || 'unknown';
      this.c.tracks[tr] = (this.c.tracks[tr] || 0) + 1;

      // Twilio: base64 μ-law 8kHz → PCM16 24kHz 로 올려서 통역 세션에
      const raw = b64ToBytes(d.media.payload);
      this.c.twBytes += raw.length;

      if (this.sessMe && this.sessMe.readyState === 1) {
        const pcm24 = up8to24(ulawToI16(raw));
        const b64 = i16ToB64(pcm24);
        this.sessMe.send(JSON.stringify({
          type: 'session.input_audio_buffer.append',
          audio: b64
        }));
        this.c.toSessMe++;
        this.c.toSessMeBytes += pcm24.length * 2;
      }
      return;
    }
    if (d.event === 'stop') this.shutdown('통화 끊김');
    else this.c.twOther++;
  }

  /* ---------- 상대에게 나갈 소리: 20ms 프레임으로 고르게 흘려보냄 ---------- */
  // 20ms 프레임 = 1개. 150개면 3초치입니다.
  // 모델이 실제 말하는 속도보다 빠르게 내보내면 큐가 계속 길어져서
  // 상대가 듣는 소리가 점점 뒤로 밀립니다. 일정 길이를 넘으면 앞을 버리고 따라잡습니다.
  enqueueToPeer(ulawBytes) {
    for (let i = 0; i < ulawBytes.length; i += 160) {
      this.outQueue.push(ulawBytes.subarray(i, Math.min(i + 160, ulawBytes.length)));
      this.c.toPeerFrames++;
    }
    const MAX_Q = 150;   // 3초
    if (this.outQueue.length > MAX_Q) {
      const drop = this.outQueue.length - 100;   // 2초치만 남깁니다
      this.outQueue.splice(0, drop);
      this.c.dropped = (this.c.dropped || 0) + drop;
    }
  }
  startPump() {
    if (this.pump) return;
    // 20ms 마다 한 프레임. 한꺼번에 쏟으면 Twilio 쪽에서 소리가 뭉갭니다.
    this.pump = setInterval(() => {
      if (this.closed) return;
      if (!this.twilio || this.twilio.readyState !== 1 || !this.streamSid) return;
      // 밀려 있으면 한 번에 두 프레임씩 빼서 조금씩 따라잡습니다
      const burst = this.outQueue.length > 60 ? 2 : 1;
      for (let k = 0; k < burst; k++) {
        const f = this.outQueue.shift();
        if (!f) return;
        try {
          this.twilio.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: bytesToB64(f) }
          }));
          this.c.sentToTwilio++;
        } catch (_) { return; }
      }
    }, 20);
  }

  toApp(obj) {
    if (this.app && this.app.readyState === 1) {
      try { this.app.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  shutdown(why) {
    if (this.closed) return;
    this.closed = true;
    if (this.pump) { clearInterval(this.pump); this.pump = null; }
    this.outQueue = [];
    this.toApp({ type: 'status', state: 'ended', why });
    for (const s of [this.sessMe, this.sessPeer, this.twilio, this.app]) {
      try { s && s.close(); } catch (_) {}
    }
    this.sessMe = this.sessPeer = this.twilio = this.app = null;
  }
}

/* ===================== 연결 시험 ===================== */
// 소켓을 열어보고 무슨 일이 생기는지 그대로 돌려줍니다.
// 지역차단이면 HTTP 403 과 본문이, 모델명이 틀리면 에러 메시지가 옵니다.
async function probeRealtime(env, url, style, opts) {
  opts = opts || {};
  url = String(url).replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const out = { url: url.replace(/\?.*$/, '?…'), 토큰형식: style || '없음', ok: false };
  if (!env.OPENAI_API_KEY) { out.error = 'OPENAI_API_KEY 없음'; return out; }
  out.토큰있음 = !!env.CF_AIG_TOKEN;
  try {
    const res = await fetch(url, { headers: aigHeaders(env, url, style) });
    out.status = res.status;
    const ws = res.webSocket;
    if (!ws) {
      try { out.body = (await res.text()).slice(0, 400); } catch (_) { out.body = '(본문 못 읽음)'; }
      return out;
    }
    ws.accept();
    out.upgraded = true;

    out.firstMessage = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('(8초 동안 아무 응답 없음)'), 8000);
      ws.addEventListener('message', e => {
        clearTimeout(timer); resolve(String(e.data).slice(0, 400));
      });
      ws.addEventListener('close', ev => {
        clearTimeout(timer); resolve(`(닫힘 code=${ev.code} reason=${ev.reason || '없음'})`);
      });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve('(소켓 오류)'); });
      // 듣기만 하는 모드: 아무것도 안 보내고 서버가 먼저 말하기를 기다립니다.
      // OpenAI 는 연결되면 session.created 를 먼저 보냅니다.
      if (opts.listenOnly) return;
      try {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: { audio: { output: { language: 'ko' } } }
        }));
      } catch (e) { clearTimeout(timer); resolve('(보내기 실패: ' + e.message + ')'); }
    });

    out.ok = true;
    try { ws.close(); } catch (_) {}
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/* ===================== 체인 폴백 (태국어 등) ===================== */

async function transcribe(env, audio, lang) {
  if (!audio) throw new Error('음성이 없습니다.');
  const form = new FormData();
  form.append('file', audio, 'audio.webm');
  form.append('model', 'whisper-1');
  if (lang) form.append('language', lc(lang));
  const res = await fetch(`${OPENAI_HTTP}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form
  });
  const d = await res.json();
  if (d.error) throw new Error('음성 인식 실패: ' + d.error.message);
  return d.text;
}

async function translateText(env, text, src, dst) {
  const res = await fetch(`${OPENAI_HTTP}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: `Translate from ${src} to ${dst}. This is a live phone conversation. Output only the translation — no notes, no quotes, no romanization.` },
        { role: 'user', content: text }
      ]
    })
  });
  const d = await res.json();
  if (d.error) throw new Error('번역 실패: ' + d.error.message);
  const out = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!out) throw new Error('번역 실패(응답형식)');
  return out.trim();
}

// ElevenLabs 를 ulaw_8000 으로 뽑으면 Twilio 에 그대로 넣을 수 있습니다 (변환 불필요)
async function ttsUlaw(env, text, lang) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs 키가 없습니다.');
  const models = ['eleven_v3', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'];
  const errs = [];
  for (const m of models) {
    try {
      const body = { text, model_id: m, voice_settings: { stability: 0.5, similarity_boost: 0.75 } };
      if (m !== 'eleven_multilingual_v2') body.language_code = lc(lang);
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_DEFAULT}?output_format=ulaw_8000`, {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) { errs.push(`${m}: HTTP ${res.status}`); continue; }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) { errs.push(`${m}: ${e.message}`); }
  }
  throw new Error('음성 생성 실패 · ' + errs.join(' | '));
}

/* ===================== 오디오 변환 =====================
   Twilio  : 8kHz μ-law
   OpenAI  : 24kHz PCM16 (little-endian)
   둘 사이를 오갈 때마다 디코드 + 리샘플이 필요합니다.            */

// μ-law 1바이트 → PCM16 (Sun 표준 알고리즘)
function ulawToI16(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xFF;
    let t = ((u & 0x0F) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    out[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
  }
  return out;
}

// PCM16 → μ-law 1바이트
const EXP_LUT = (() => {
  const t = new Uint8Array(256);
  for (let i = 1; i < 256; i++) t[i] = 31 - Math.clz32(i);
  t[0] = 0;
  return t;
})();
function i16ToUlaw(samples) {
  const CLIP = 32635, BIAS = 0x84;
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    const sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    const exp = EXP_LUT[(s >> 7) & 0xFF];
    const man = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | man) & 0xFF;
  }
  return out;
}

// 8kHz → 24kHz (선형 보간으로 3배)
function up8to24(src) {
  const n = src.length;
  const out = new Int16Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = src[i];
    const b = (i + 1 < n) ? src[i + 1] : a;
    const step = (b - a) / 3;
    out[i * 3]     = a;
    out[i * 3 + 1] = a + step;
    out[i * 3 + 2] = a + step * 2;
  }
  return out;
}

// 24kHz → 8kHz (3개 평균 — 그냥 버리면 잡음이 낍니다)
function down24to8(src) {
  const n = Math.floor(src.length / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = ((src[i * 3] + src[i * 3 + 1] + src[i * 3 + 2]) / 3) | 0;
  }
  return out;
}

/* ---------- base64 ---------- */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function b64ToI16(b64) {
  const bytes = b64ToBytes(b64);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
}
function i16ToB64(samples) {
  return bytesToB64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
}

/* ---------- 기타 ---------- */
const escXml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

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
