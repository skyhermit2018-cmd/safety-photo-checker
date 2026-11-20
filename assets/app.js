/* 산업안전 사진 판독 — 앱 로직
 * 외부 라이브러리 없이 동작하는 정적 웹앱. 서버·중계 없음.
 */
(function () {
  'use strict';

  /* ───────────────────────── 상수 ───────────────────────── */
  var LS_SETTINGS = 'spc.settings.v1';
  var LS_HISTORY = 'spc.history.v1';
  var HISTORY_MAX = 20;
  var IMG_MAX_SIDE = 1280;
  var IMG_QUALITY = 0.82;
  var THUMB_MAX_SIDE = 320;
  var THUMB_QUALITY = 0.55;
  var MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
  var REQUEST_TIMEOUT_MS = 120000;

  var PROVIDERS = {
    gemini: {
      name: 'Google Gemini',
      keyUrl: 'https://aistudio.google.com/app/apikey',
      keyUrlLabel: 'aistudio.google.com/app/apikey',
      keyHelp: 'AI Studio에서 발급한 키(AIza… 또는 AQ.…)를 붙여넣으세요. 무료 티어로 사용할 수 있습니다.',
      models: [
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash · 권장 (균형)' },
        { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite · 빠름·저렴' },
        { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash · 안정판' }
      ]
    },
    openai: {
      name: 'OpenAI',
      keyUrl: 'https://platform.openai.com/api-keys',
      keyUrlLabel: 'platform.openai.com/api-keys',
      keyHelp: 'sk-… 키를 붙여넣으세요. OpenAI API는 선불 크레딧이 필요합니다.',
      models: [
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini · 권장 (저렴)' },
        { id: 'gpt-4o', label: 'gpt-4o · 정밀' }
      ]
    }
  };

  var RISKS = ['위험', '주의', '양호'];
  var SEVERITIES = ['위험', '주의', '양호'];
  var CONFIDENCES = ['높음', '보통', '낮음'];

  var SYSTEM_PROMPT = [
    '당신은 대한민국 건설·산업현장 안전관리 전문가입니다. 「산업안전보건법」, 「산업안전보건기준에 관한 규칙」, 「중대재해 처벌 등에 관한 법률」과 건설현장 안전 실무에 정통합니다.',
    '사용자는 현장 안전관리자이며, 스마트폰으로 찍은 사진 1장을 올려 위험요인과 법령 위반 소지를 확인하려 합니다.',
    '',
    '[판단 원칙]',
    '1. 사진에서 실제로 식별되는 것만 근거로 삼습니다. 보이지 않는 부분은 추측하지 말고 notes에 "사진으로 확인 불가"로 적습니다.',
    '2. 위반을 단정하지 않습니다. "위반 소지", "기준 미준수 의심"과 같이 표현합니다.',
    '3. 법령 조문은 [참고 조문] 목록에 있는 것만 번호를 인용하고, 목록에 없는 조문은 법령명과 조문 제목만 쓰고 번호는 쓰지 않습니다. 존재하지 않는 조문 번호를 만들지 않습니다.',
    '4. 위험등급(risk_level)은 중대재해(사망·중상) 가능성을 기준으로 냉정하게 정합니다.',
    '   - 위험: 즉시 작업중지·보호조치가 필요한 결함. 예) 2m 이상 고소작업에서 안전난간·안전대 없음, 충전부 노출, 흙막이 없이 수직에 가까운 굴착면, 인양물 바로 아래 근로자 통행.',
    '   - 주의: 기준 미달·관리 소홀로 사고 위험이 있는 상태. 예) 발끝막이판 누락, 통로 적치, 보호구 미착용, 점검 기록 없음.',
    '   - 양호: 뚜렷한 결함이 보이지 않음. 이 경우에도 사진으로 확인되지 않는 사항을 notes에 적습니다.',
    '5. findings는 사진에서 확인되는 것만, 위험이 큰 순서로 최대 6개. 각 항목에 사진 속 위치(예: "사진 우측 상단, 2층 슬라브 단부")를 적습니다.',
    '6. actions는 오늘 현장에서 바로 할 수 있는 구체적 조치 3~6개. "안전관리를 철저히 한다" 같은 추상적 문구는 쓰지 않습니다.',
    '7. 모든 출력은 한국어. 결과는 지정된 JSON 객체 하나만 출력하고 코드블록·설명 문장을 붙이지 않습니다.'
  ].join('\n');

  var RESULT_SCHEMA = {
    type: 'OBJECT',
    properties: {
      risk_level: { type: 'STRING', enum: RISKS },
      summary: { type: 'STRING' },
      findings: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            severity: { type: 'STRING', enum: SEVERITIES },
            location: { type: 'STRING' },
            description: { type: 'STRING' },
            law: { type: 'STRING' },
            violation_reason: { type: 'STRING' },
            confidence: { type: 'STRING', enum: CONFIDENCES }
          },
          required: ['title', 'severity', 'description', 'law', 'violation_reason']
        }
      },
      actions: { type: 'ARRAY', items: { type: 'STRING' } },
      legal_basis: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            law: { type: 'STRING' },
            article: { type: 'STRING' },
            gist: { type: 'STRING' }
          },
          required: ['law', 'article', 'gist']
        }
      },
      notes: { type: 'STRING' }
    },
    required: ['risk_level', 'summary', 'findings', 'actions', 'legal_basis', 'notes']
  };

  var WORKTYPES = window.SPC_WORKTYPES || [{ id: 'auto', label: '자동 판별', prompt: '자동 판별', tags: ['공통'] }];

  /* ───────────────────────── DOM 헬퍼 ───────────────────────── */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function str(v, max) {
    var s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    return max ? s.slice(0, max) : s;
  }
  function toArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.setAttribute('data-kind', kind || 'info');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, kind === 'error' ? 4200 : 2400);
  }

  /* ───────────────────────── 상태 ───────────────────────── */
  var state = {
    settings: null,
    photo: null,          // { dataUrl, thumb, width, height, bytes, name }
    workType: 'auto',
    busy: false,
    controller: null,
    timedOut: false,
    result: null,
    statusIdx: 0,
    statusTimer: null,
    clockTimer: null,
    startedAt: 0
  };

  var STATUS_MESSAGES = [
    '사진 분석 중…',
    '위험 요인 확인 중…',
    '법령 근거 정리 중…',
    '보고서 형식으로 정리 중…'
  ];

  /* ───────────────────────── 설정 저장 ───────────────────────── */
  function defaultSettings() {
    return {
      provider: 'gemini',
      models: { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini' },
      keys: { gemini: '', openai: '' }
    };
  }

  function loadSettings() {
    var out = defaultSettings();
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null'); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      if (raw.provider === 'gemini' || raw.provider === 'openai') out.provider = raw.provider;
      if (raw.models && typeof raw.models === 'object') {
        ['gemini', 'openai'].forEach(function (k) { if (typeof raw.models[k] === 'string') out.models[k] = raw.models[k]; });
      }
      if (raw.keys && typeof raw.keys === 'object') {
        ['gemini', 'openai'].forEach(function (k) { if (typeof raw.keys[k] === 'string') out.keys[k] = raw.keys[k].trim(); });
      }
    }
    return out;
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
      return true;
    } catch (e) {
      toast('브라우저 저장 공간에 키를 저장하지 못했습니다. 시크릿 모드인지 확인하세요.', 'error');
      return false;
    }
  }

  function currentKey() { return state.settings.keys[state.settings.provider] || ''; }
  function currentModel() { return state.settings.models[state.settings.provider]; }

  function updateKeyStatus() {
    var has = !!currentKey();
    var dot = $('#keyDot');
    var text = $('#keyDotText');
    if (dot) dot.setAttribute('data-state', has ? 'ready' : 'missing');
    if (text) {
      text.textContent = has
        ? PROVIDERS[state.settings.provider].name + ' API 키가 설정되어 있습니다'
        : 'API 키가 설정되지 않았습니다';
    }
    var notice = $('#keyNotice');
    if (notice) notice.hidden = has;
    var sub = $('#statusSub');
    if (sub && state.photo) updateReadyStatus();
    if (sub && !state.photo) renderIdleStatus();
  }

  /* ───────────────────────── 공종 칩 ───────────────────────── */
  function renderChips() {
    var wrap = $('#chips');
    if (!wrap) return;
    wrap.innerHTML = WORKTYPES.map(function (w) {
      return '<button type="button" class="chip" role="radio" aria-checked="' + (w.id === state.workType) + '"' +
        ' data-work="' + esc(w.id) + '"><span class="chip-dot" aria-hidden="true"></span>' + esc(w.label) + '</button>';
    }).join('');
  }

  function selectWorkType(id) {
    state.workType = id;
    $$('#chips .chip').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-work') === id));
    });
  }

  /* ───────────────────────── 사진 처리 ───────────────────────── */
  function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return decodeWithImage(file);
      });
    }
    return decodeWithImage(file);
  }

  function decodeWithImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('이 사진 형식은 브라우저에서 열 수 없습니다. JPG나 PNG로 바꿔 주세요.'));
      };
      img.src = url;
    });
  }

  function drawResized(bitmap, maxSide, quality) {
    var ow = bitmap.width || bitmap.naturalWidth;
    var oh = bitmap.height || bitmap.naturalHeight;
    if (!ow || !oh) throw new Error('사진 크기를 읽을 수 없습니다.');
    var scale = Math.min(1, maxSide / Math.max(ow, oh));
    var w = Math.max(1, Math.round(ow * scale));
    var h = Math.max(1, Math.round(oh * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    var dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!dataUrl || dataUrl.indexOf('data:image/jpeg') !== 0) throw new Error('사진을 변환하지 못했습니다.');
    var bytes = Math.round((dataUrl.length - 23) * 0.75);
    return { dataUrl: dataUrl, width: w, height: h, bytes: bytes };
  }

  function processImage(file) {
    if (!file || !/^image\//.test(file.type)) {
      toast('이미지 파일만 올릴 수 있습니다.', 'error');
      return Promise.resolve(false);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast('사진이 너무 큽니다(30MB 초과). 더 작은 사진을 사용해 주세요.', 'error');
      return Promise.resolve(false);
    }
    return loadBitmap(file).then(function (bitmap) {
      var main = drawResized(bitmap, IMG_MAX_SIDE, IMG_QUALITY);
      var thumb = drawResized(bitmap, THUMB_MAX_SIDE, THUMB_QUALITY);
      if (bitmap.close) bitmap.close();
      return {
        dataUrl: main.dataUrl,
        width: main.width,
        height: main.height,
        bytes: main.bytes,
        thumb: thumb.dataUrl,
        name: file.name || 'photo.jpg'
      };
    }).then(function (photo) {
      setPhoto(photo);
      return true;
    }).catch(function (err) {
      toast(err.message || '사진을 처리하지 못했습니다.', 'error');
      return false;
    });
  }

  function setPhoto(photo) {
    state.photo = photo;
    var img = $('#previewImg');
    if (img) img.src = photo.dataUrl;
    var empty = $('#dropEmpty');
    var prev = $('#dropPreview');
    if (empty) empty.hidden = true;
    if (prev) prev.hidden = false;
    var info = $('#previewInfo');
    if (info) info.textContent = photo.width + '×' + photo.height + ' · ' + fmtBytes(photo.bytes) + ' · 전송용으로 자동 축소';
    hideResult();
    updateReadyStatus();
  }

  function clearPhoto() {
    state.photo = null;
    var img = $('#previewImg');
    if (img) img.removeAttribute('src');
    var empty = $('#dropEmpty');
    var prev = $('#dropPreview');
    if (empty) empty.hidden = false;
    if (prev) prev.hidden = true;
    var cam = $('#cameraInput'); if (cam) cam.value = '';
    var fi = $('#fileInput'); if (fi) fi.value = '';
    renderIdleStatus();
  }

  /* ───────────────────────── 상태 표시 ───────────────────────── */
  function renderIdleStatus() {
    var t = $('#statusText');
    var s = $('#statusSub');
    var btn = $('#btnAnalyze');
    if (t) t.textContent = '사진을 선택해 주세요';
    if (s) s.textContent = '촬영하거나 앨범에서 고르면 바로 판독할 수 있습니다';
    if (btn) btn.disabled = true;
  }

  function updateReadyStatus() {
    if (!state.photo || state.busy) return;
    var t = $('#statusText');
    var s = $('#statusSub');
    var btn = $('#btnAnalyze');
    var wt = WORKTYPES.filter(function (w) { return w.id === state.workType; })[0] || WORKTYPES[0];
    if (t) t.textContent = '판독 준비 완료';
    if (s) {
      s.textContent = wt.label + ' · ' + fmtBytes(state.photo.bytes) +
        (currentKey() ? ' · ' + PROVIDERS[state.settings.provider].name : ' · API 키 필요');
    }
    if (btn) btn.disabled = false;
  }

  function setBusy(busy) {
    state.busy = busy;
    var btn = $('#btnAnalyze');
    var label = $('#btnAnalyzeLabel');
    var spin = $('#runSpinner');
    var line = $('#progressLine');
    if (!btn) return;
    btn.classList.toggle('is-busy', busy);
    btn.disabled = busy ? false : !state.photo;
    if (label) label.textContent = busy ? '취소' : 'AI 판독 시작';
    if (spin) spin.hidden = !busy;
    if (line) line.hidden = !busy;
    if (busy) {
      state.statusIdx = 0;
      state.startedAt = Date.now();
      var t = $('#statusText');
      if (t) t.textContent = 'AI가 사진을 판독하고 있습니다';
      updateClock();
      clearInterval(state.statusTimer);
      state.statusTimer = setInterval(function () {
        state.statusIdx = (state.statusIdx + 1) % STATUS_MESSAGES.length;
        updateClock();
      }, 5000);
      clearInterval(state.clockTimer);
      state.clockTimer = setInterval(updateClock, 1000);
    } else {
      clearInterval(state.statusTimer);
      clearInterval(state.clockTimer);
      updateReadyStatus();
    }
  }

  function updateClock() {
    var s = $('#statusSub');
    if (!s || !state.busy) return;
    var sec = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
    var mm = Math.floor(sec / 60);
    var ss = pad2(sec % 60);
    s.textContent = STATUS_MESSAGES[state.statusIdx] + ' · ' + mm + ':' + ss;
  }

  /* ───────────────────────── 프롬프트 ───────────────────────── */
  function buildPrompt() {
    var wt = WORKTYPES.filter(function (w) { return w.id === state.workType; })[0] || WORKTYPES[0];
    var memoEl = $('#memo');
    var memo = memoEl ? memoEl.value.trim() : '';
    var refs = (window.SPC_LEGAL || []).map(function (e) {
      return '- ' + e.law + ' ' + e.article + '(' + e.title + '): ' + e.point;
    }).join('\n');

    return [
      '[점검 정보]',
      '- 공종: ' + wt.prompt,
      '- 현장 메모: ' + (memo || '없음'),
      '',
      '[참고 조문 — 이 목록에 있는 조문만 번호를 인용할 수 있음]',
      refs,
      '',
      '[요청]',
      '위 사진을 판단 원칙에 따라 판독하고, 아래 형식의 JSON 객체 하나만 출력하세요.',
      'summary는 2~3문장으로 사진에서 보이는 상태와 가장 큰 위험을 요약합니다.',
      'legal_basis의 gist는 조문의 핵심 기준을 한 줄로 적습니다(조문 원문을 길게 옮기지 않습니다).',
      '{"risk_level":"위험|주의|양호","summary":"","findings":[{"title":"","severity":"위험|주의|양호","location":"","description":"","law":"","violation_reason":"","confidence":"높음|보통|낮음"}],"actions":[""],"legal_basis":[{"law":"","article":"","gist":""}],"notes":""}'
    ].join('\n');
  }

  /* ───────────────────────── AI 호출 ───────────────────────── */
  function parseJsonLoose(text) {
    if (!text) throw new Error('AI 응답이 비어 있습니다.');
    var t = String(text).trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 아래에서 보정 */ }
    var start = t.indexOf('{');
    var end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    try { return JSON.parse(t); } catch (e) { /* 보정 */ }
    var fixed = t.replace(/,\s*([}\]])/g, '$1').replace(/[\u201C\u201D]/g, '"');
    try { return JSON.parse(fixed); } catch (e) {
      throw new Error('AI 응답을 JSON으로 해석하지 못했습니다. 다시 시도해 주세요.');
    }
  }

  function describeError(res, provider) {
    return res.text().then(function (t) {
      var detail = t;
      try {
        var j = JSON.parse(t);
        detail = (j && j.error && (j.error.message || j.error.status)) || (j && j.message) || t;
      } catch (e) { /* 원문 유지 */ }
      detail = String(detail || '').slice(0, 220);
      var s = res.status;
      var msg;
      if (s === 400) {
        msg = /api key not valid|API_KEY_INVALID|invalid api key|incorrect api key/i.test(detail)
          ? 'API 키가 올바르지 않습니다.'
          : '요청이 거부되었습니다(400). 모델과 입력을 확인하세요.';
      } else if (s === 401) {
        msg = 'API 키가 올바르지 않거나 만료되었습니다.';
      } else if (s === 403) {
        msg = '키 권한·결제 상태·지역 제한으로 거부되었습니다. 제공사 콘솔에서 확인하세요.';
      } else if (s === 404) {
        msg = '모델을 찾을 수 없습니다. 목록에서 다른 모델을 골라 보세요.';
      } else if (s === 413) {
        msg = '사진이 너무 큽니다. 더 작은 사진으로 시도해 주세요.';
      } else if (s === 429) {
        msg = provider === 'gemini'
          ? '요청 한도(무료 티어)를 초과했습니다. 잠시 후 다시 시도하세요.'
          : 'OpenAI 사용 한도 또는 크레딧을 확인하세요.';
      } else if (s >= 500) {
        msg = '제공사 서버에 일시적 문제가 있습니다. 잠시 후 다시 시도하세요.';
      } else {
        msg = '요청이 실패했습니다 (HTTP ' + s + ').';
      }
      return detail ? msg + ' — ' + detail : msg;
    });
  }

  function callGemini(opts, noThinkingConfig) {
    var b64 = opts.imageDataUrl.split(',')[1];
    var gen = {
      temperature: 0.15,
      topP: 0.9,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: RESULT_SCHEMA
    };
    if (!noThinkingConfig && /^gemini-2\.5/.test(opts.model)) gen.thinkingConfig = { thinkingBudget: 0 };

    var body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: opts.prompt }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }],
      generationConfig: gen
    };

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(opts.model) + ':generateContent';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.key },
      body: JSON.stringify(body),
      signal: opts.signal
    }).then(function (res) {
      if (!res.ok) {
        return describeError(res, 'gemini').then(function (m) {
          // thinking 설정을 지원하지 않는 모델이면 한 번만 설정 없이 재시도
          if (!noThinkingConfig && res.status === 400 && /thinking/i.test(m)) {
            return callGemini(opts, true);
          }
          throw new Error(m);
        });
      }
      return res.json();
    }).then(function (data) {
      var cand = (data.candidates || [])[0];
      if (!cand) {
        var blocked = data.promptFeedback && data.promptFeedback.blockReason;
        throw new Error(blocked
          ? '사진이 제공사 안전 정책으로 처리되지 않았습니다(' + blocked + '). 다른 사진으로 시도해 주세요.'
          : 'AI가 결과를 반환하지 않았습니다. 다시 시도해 주세요.');
      }
      var text = ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ''; }).join('').trim();
      if (!text) {
        if (cand.finishReason === 'MAX_TOKENS') throw new Error('응답이 길이 제한으로 잘렸습니다. 다시 시도해 주세요.');
        if (cand.finishReason === 'SAFETY') throw new Error('사진이 안전 정책으로 차단되었습니다. 다른 사진으로 시도해 주세요.');
        throw new Error('AI 응답이 비어 있습니다. 다시 시도해 주세요.');
      }
      return parseJsonLoose(text);
    });
  }

  function callOpenAI(opts) {
    var body = {
      model: opts.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.prompt },
            { type: 'image_url', image_url: { url: opts.imageDataUrl, detail: 'high' } }
          ]
        }
      ],
      temperature: 0.15,
      max_tokens: 2500,
      response_format: { type: 'json_object' }
    };

    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.key },
      body: JSON.stringify(body),
      signal: opts.signal
    }).then(function (res) {
      if (!res.ok) return describeError(res, 'openai').then(function (m) { throw new Error(m); });
      return res.json();
    }).then(function (data) {
      var choice = (data.choices || [])[0];
      var text = (choice && choice.message && choice.message.content) || '';
      if (!text) throw new Error('AI 응답이 비어 있습니다. 다시 시도해 주세요.');
      if (choice.finish_reason === 'length') throw new Error('응답이 길이 제한으로 잘렸습니다. 다시 시도해 주세요.');
      return parseJsonLoose(text);
    });
  }

  /* ───────────────────────── 결과 정규화 ───────────────────────── */
  function pickFrom(v, allowed, fallback) {
    var s = str(v);
    return allowed.indexOf(s) >= 0 ? s : fallback;
  }

  function deriveRisk(findings) {
    if (!findings.length) return '주의';
    if (findings.some(function (f) { return f.severity === '위험'; })) return '위험';
    if (findings.some(function (f) { return f.severity === '주의'; })) return '주의';
    return '양호';
  }

  function normalizeResult(raw, ctx) {
    if (Array.isArray(raw)) raw = raw[0] || {};
    if (!raw || typeof raw !== 'object') throw new Error('AI 응답 형식이 올바르지 않습니다.');

    var findings = toArray(raw.findings).map(function (f) {
      if (typeof f === 'string') return { title: str(f, 120), severity: '주의', location: '', description: '', law: '', violation: '', confidence: '보통' };
      f = f || {};
      return {
        title: str(f.title || f.name || f.issue, 120),
        severity: pickFrom(f.severity, SEVERITIES, '주의'),
        location: str(f.location || f.where, 120),
        description: str(f.description || f.detail || f.content, 700),
        law: str(f.law || f.legal_basis || f.regulation, 220),
        violation: str(f.violation_reason || f.violation || f.reason, 600),
        confidence: pickFrom(f.confidence, CONFIDENCES, '보통')
      };
    }).filter(function (f) { return f.title || f.description; }).slice(0, 8);

    var risk = pickFrom(raw.risk_level || raw.risk || raw.grade, RISKS, null);
    if (!risk) risk = deriveRisk(findings);

    var actions = toArray(raw.actions).map(function (a) {
      if (typeof a === 'string') return str(a, 320);
      if (a && typeof a === 'object') return str(a.action || a.text || a.measure, 320);
      return '';
    }).filter(Boolean).slice(0, 8);

    var legal = toArray(raw.legal_basis || raw.legal || raw.laws).map(function (l) {
      if (typeof l === 'string') return { law: '', article: '', gist: str(l, 320) };
      l = l || {};
      return {
        law: str(l.law || l.act, 90),
        article: str(l.article || l.clause || l.provision, 90),
        gist: str(l.gist || l.summary || l.point || l.content, 420)
      };
    }).filter(function (l) { return l.law || l.article || l.gist; }).slice(0, 10);

    var wt = WORKTYPES.filter(function (w) { return w.id === ctx.workType; })[0] || WORKTYPES[0];

    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      workType: ctx.workType,
      workLabel: wt.label,
      memo: ctx.memo || '',
      provider: ctx.provider,
      model: ctx.model,
      risk: risk,
      summary: str(raw.summary || raw.overview, 800),
      findings: findings,
      actions: actions,
      legal: legal,
      notes: str(raw.notes || raw.limitations || raw.caveats, 900),
      photo: ctx.photo ? ctx.photo.dataUrl : '',
      thumb: ctx.photo ? ctx.photo.thumb : null,
      elapsed: ctx.elapsed || 0
    };
  }

  /* ───────────────────────── 판독 실행 ───────────────────────── */
  function analyze() {
    if (state.busy) {
      state.timedOut = false;
      if (state.controller) state.controller.abort();
      return;
    }
    if (!state.photo) {
      toast('사진을 먼저 선택해 주세요.', 'error');
      return;
    }
    if (!currentKey()) {
      toast('API 키를 먼저 설정해 주세요.', 'error');
      openSettings();
      return;
    }

    var provider = state.settings.provider;
    var model = currentModel();
    var prompt = buildPrompt();
    var memoEl = $('#memo');
    var memo = memoEl ? memoEl.value.trim() : '';

    state.timedOut = false;
    state.controller = new AbortController();
    var controller = state.controller;
    var started = Date.now();
    var timer = setTimeout(function () {
      state.timedOut = true;
      try { controller.abort(); } catch (e) { /* noop */ }
    }, REQUEST_TIMEOUT_MS);

    clearError();
    setBusy(true);
    if ($('#resultSection')) $('#resultSection').hidden = true;

    var opts = {
      key: currentKey(),
      model: model,
      prompt: prompt,
      imageDataUrl: state.photo.dataUrl,
      signal: controller.signal
    };

    var call = provider === 'gemini' ? callGemini(opts) : callOpenAI(opts);

    call.then(function (raw) {
      clearTimeout(timer);
      var result = normalizeResult(raw, {
        provider: provider,
        model: model,
        workType: state.workType,
        memo: memo,
        photo: state.photo,
        elapsed: Date.now() - started
      });
      renderResult(result);
      addHistory(result);
      toast('판독이 완료되었습니다');
      scrollToResult();
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        if (state.timedOut) {
          showError('판독 시간이 초과되었습니다', '120초 안에 응답이 오지 않았습니다. 네트워크 상태를 확인하고 다시 시도하거나, 더 작은 사진·다른 모델로 시도해 보세요.');
        } else {
          toast('판독을 취소했습니다');
        }
      } else if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message))) {
        showError('네트워크 오류로 판독하지 못했습니다', '인터넷 연결을 확인하세요. 브라우저 확장 프로그램·회사 방화벽이 요청을 막는 경우도 있습니다. 계속 실패하면 다른 네트워크(모바일 데이터)에서 시도해 보세요.');
      } else {
        showError('판독하지 못했습니다', (err && err.message) || '알 수 없는 오류입니다. 잠시 후 다시 시도해 주세요.');
      }
    }).then(function () {
      state.controller = null;
      setBusy(false);
    });
  }

  function scrollToResult() {
    var el = $('#resultSection');
    if (!el) return;
    try {
      window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - 64, behavior: 'smooth' });
    } catch (e) {
      el.scrollIntoView();
    }
  }

  /* ───────────────────────── 오류 패널 ───────────────────────── */
  function clearError() {
    var p = $('#errorPanel');
    if (p) p.remove();
  }

  function showError(title, detail) {
    clearError();
    var sec = document.createElement('section');
    sec.id = 'errorPanel';
    sec.className = 'card error-card';
    sec.setAttribute('role', 'alert');
    sec.innerHTML =
      '<div class="error-head"><span class="error-mark" aria-hidden="true">!</span><h2>' + esc(title) + '</h2></div>' +
      '<p class="error-detail">' + esc(detail) + '</p>' +
      '<div class="error-actions">' +
      '<button type="button" class="btn btn-ghost btn-small" id="btnErrorSettings">API 키 설정 열기</button>' +
      '<button type="button" class="btn btn-small btn-primary" id="btnErrorRetry">다시 시도</button>' +
      '</div>';
    var main = $('#main');
    var before = $('#resultSection');
    if (main && before) main.insertBefore(sec, before);
    else if (main) main.appendChild(sec);
    var s = $('#btnErrorSettings');
    if (s) s.addEventListener('click', openSettings);
    var r = $('#btnErrorRetry');
    if (r) r.addEventListener('click', function () { clearError(); analyze(); });
    toast(title, 'error');
  }

  /* ───────────────────────── 결과 렌더 ───────────────────────── */
  function hideResult() {
    var el = $('#resultSection');
    if (el) el.hidden = true;
    state.result = null;
  }

  function renderResult(r) {
    state.result = r;
    var sec = $('#resultSection');
    if (!sec) return;

    var badge = $('#riskBadge');
    if (badge) {
      badge.setAttribute('data-risk', r.risk);
      var label = $('#riskLabel');
      if (label) label.textContent = r.risk;
    }

    var time = $('#resultTime');
    if (time) time.textContent = fmtDateTime(r.at);
    var model = $('#resultModel');
    if (model) model.textContent = (PROVIDERS[r.provider] ? PROVIDERS[r.provider].name : r.provider) + ' · ' + r.model;

    var summary = $('#resultSummary');
    if (summary) summary.textContent = r.summary || '요약이 제공되지 않았습니다. 아래 위험 요인을 확인하세요.';

    var photoWrap = $('#resultPhotoWrap');
    var photoEl = $('#resultPhoto');
    var src = r.photo || r.thumb || '';
    if (photoEl && src) {
      photoEl.src = src;
      photoEl.alt = '판독한 현장 사진 (' + r.workLabel + ')';
      if (photoWrap) photoWrap.hidden = false;
    } else if (photoWrap) {
      photoWrap.hidden = true;
    }

    var fc = $('#findingsCount');
    if (fc) fc.textContent = r.findings.length;

    var list = $('#findingsList');
    if (list) {
      if (!r.findings.length) {
        list.innerHTML = '<li class="empty-note">사진에서 뚜렷한 위험 요인을 찾지 못했습니다. 사진 각도·거리·가림 때문에 확인되지 않는 부분은 아래 확인 항목을 참고하세요.</li>';
      } else {
        list.innerHTML = r.findings.map(function (f) {
          var parts = ['<li class="finding" data-sev="' + esc(f.severity) + '">'];
          parts.push('<div class="finding-head">');
          parts.push('<span class="sev-chip" data-sev="' + esc(f.severity) + '">' + esc(f.severity) + '</span>');
          parts.push('<h4>' + esc(f.title || '위험 요인') + '</h4>');
          if (f.confidence) parts.push('<span class="conf">신뢰도 ' + esc(f.confidence) + '</span>');
          parts.push('</div>');
          if (f.location) parts.push('<p class="f-loc">위치 · ' + esc(f.location) + '</p>');
          if (f.description) parts.push('<p class="f-desc">' + esc(f.description) + '</p>');
          if (f.law || f.violation) {
            parts.push('<div class="law-line"><b>관련 법령 · 위반 소지</b>');
            if (f.law) parts.push('<div class="law-name">' + esc(f.law) + '</div>');
            if (f.violation) parts.push('<div class="law-why">' + esc(f.violation) + '</div>');
            parts.push('</div>');
          }
          parts.push('</li>');
          return parts.join('');
        }).join('');
      }
    }

    var actions = $('#actionsList');
    if (actions) {
      actions.innerHTML = r.actions.length
        ? r.actions.map(function (a, i) {
            return '<li><label><input type="checkbox" data-act="' + i + '"><span>' + esc(a) + '</span></label></li>';
          }).join('')
        : '<li class="empty-note">제안된 조치가 없습니다.</li>';
    }

    var lc = $('#legalCount');
    if (lc) lc.textContent = r.legal.length;
    var legalList = $('#legalList');
    if (legalList) {
      legalList.innerHTML = r.legal.length
        ? r.legal.map(function (l) {
            var head = [l.law, l.article].filter(Boolean).join(' ');
            return '<li>' + (head ? '<strong>' + esc(head) + '</strong>' : '') + (l.gist ? esc(l.gist) : '') + '</li>';
          }).join('')
        : '<li>제시된 조문이 없습니다. 법령 원문을 직접 확인하세요.</li>';
    }
    var legalBox = $('#legalBox');
    if (legalBox) legalBox.open = r.legal.length > 0 && r.legal.length <= 4;

    var notesBox = $('#notesBox');
    var notesText = $('#notesText');
    if (notesBox && notesText) {
      if (r.notes) { notesText.textContent = r.notes; notesBox.hidden = false; }
      else { notesBox.hidden = true; }
    }

    sec.hidden = false;
  }

  /* ───────────────────────── 보고용 텍스트 ───────────────────────── */
  function oneLine(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

  function buildReport(r) {
    var lines = [];
    lines.push('[산업안전 사진 AI 판독 결과]');
    lines.push('일시: ' + fmtDateTime(r.at));
    lines.push('공종: ' + r.workLabel + (r.workType === 'auto' ? ' (자동 판별)' : ''));
    if (r.memo) lines.push('현장 메모: ' + oneLine(r.memo));
    lines.push('');
    lines.push('■ 종합 위험등급: ' + r.risk);
    if (r.summary) lines.push(oneLine(r.summary));
    lines.push('');

    if (r.findings.length) {
      lines.push('■ 발견된 위험 요인 (' + r.findings.length + '건)');
      r.findings.forEach(function (f, i) {
        lines.push((i + 1) + '. [' + f.severity + '] ' + oneLine(f.title));
        if (f.location) lines.push('   · 위치: ' + oneLine(f.location));
        if (f.description) lines.push('   · 내용: ' + oneLine(f.description));
        if (f.law) lines.push('   · 관련 법령: ' + oneLine(f.law));
        if (f.violation) lines.push('   · 위반 소지: ' + oneLine(f.violation));
      });
      lines.push('');
    }

    if (r.actions.length) {
      lines.push('■ 즉시 시정·개선 조치');
      r.actions.forEach(function (a, i) { lines.push(' ' + (i + 1) + ') ' + oneLine(a)); });
      lines.push('');
    }

    if (r.legal.length) {
      lines.push('■ 법령 근거');
      r.legal.forEach(function (l) {
        var head = [l.law, l.article].filter(Boolean).join(' ');
        lines.push(' - ' + head + (l.gist ? ': ' + oneLine(l.gist) : ''));
      });
      lines.push('');
    }

    if (r.notes) {
      lines.push('■ 확인 필요');
      lines.push(oneLine(r.notes));
      lines.push('');
    }

    lines.push('※ AI 판독 결과는 현장 점검 참고용이며, 최종 법적 판단은 안전관리자 및 법령 원문 확인이 필요합니다.');
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-2000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ───────────────────────── 히스토리 ───────────────────────── */
  function loadHistory() {
    try {
      var a = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
      return Array.isArray(a) ? a.filter(function (x) { return x && x.id && x.at; }) : [];
    } catch (e) {
      return [];
    }
  }

  function writeHistory(list) {
    try {
      localStorage.setItem(LS_HISTORY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 저장 공간이 부족하면 ①최신 1건만 썸네일 유지 ②모든 썸네일 제거 ③오래된 기록부터 삭제 */
  function persistHistory(list) {
    var keepNewest = list.map(function (x, i) { return i === 0 ? x : (x.thumb ? Object.assign({}, x, { thumb: null }) : x); });
    var noThumbs = list.map(function (x) { return x.thumb ? Object.assign({}, x, { thumb: null }) : x; });
    var candidates = [list, keepNewest, noThumbs];
    for (var c = 0; c < candidates.length; c++) {
      if (writeHistory(candidates[c])) return candidates[c];
    }
    var trimmed = noThumbs;
    while (trimmed.length > 1) {
      trimmed = trimmed.slice(0, trimmed.length - 1);
      if (writeHistory(trimmed)) return trimmed;
    }
    try { localStorage.removeItem(LS_HISTORY); } catch (e) { /* noop */ }
    return [];
  }

  function addHistory(r) {
    var entry = {
      id: r.id, at: r.at, workType: r.workType, workLabel: r.workLabel, memo: r.memo,
      provider: r.provider, model: r.model, risk: r.risk, summary: r.summary,
      findings: r.findings, actions: r.actions, legal: r.legal, notes: r.notes,
      thumb: r.thumb || null, elapsed: r.elapsed || 0
    };
    var list = loadHistory();
    list.unshift(entry);
    list = list.slice(0, HISTORY_MAX);
    persistHistory(list);
    renderHistory();
  }

  function renderHistory() {
    var list = loadHistory();
    var ul = $('#historyList');
    var empty = $('#historyEmpty');
    var clear = $('#btnClearHistory');
    if (!ul) return;
    if (!list.length) {
      ul.innerHTML = '';
      if (empty) empty.hidden = false;
      if (clear) clear.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (clear) clear.hidden = false;
    ul.innerHTML = list.map(function (h) {
      var thumb = h.thumb
        ? '<img class="thumb" src="' + esc(h.thumb) + '" alt="" loading="lazy">'
        : '<span class="thumb" aria-hidden="true"></span>';
      return '<li class="history-item" data-id="' + esc(h.id) + '">' +
        thumb +
        '<div class="history-main">' +
          '<div class="history-top">' +
            '<span class="mini-badge" data-risk="' + esc(h.risk) + '">' + esc(h.risk) + '</span>' +
            '<b>' + esc(h.workLabel) + '</b>' +
            '<span class="history-date">' + esc(fmtDateTime(h.at)) + '</span>' +
          '</div>' +
          '<p class="history-sum">' + esc(oneLine(h.summary) || '요약 없음') + '</p>' +
        '</div>' +
        '<div class="history-actions">' +
          '<button type="button" class="history-open" data-open="' + esc(h.id) + '">보기</button>' +
          '<button type="button" class="history-del" data-del="' + esc(h.id) + '">삭제</button>' +
        '</div>' +
      '</li>';
    }).join('');
  }

  function openHistoryItem(id) {
    var h = loadHistory().filter(function (x) { return x.id === id; })[0];
    if (!h) { toast('기록을 찾을 수 없습니다.', 'error'); return; }
    var r = Object.assign({}, h, { photo: h.thumb || '' });
    renderResult(r);
    scrollToResult();
    toast('저장된 점검 기록을 열었습니다');
  }

  function removeHistoryItem(id) {
    var list = loadHistory().filter(function (x) { return x.id !== id; });
    persistHistory(list);
    renderHistory();
    if (state.result && state.result.id === id) hideResult();
    toast('기록을 삭제했습니다');
  }

  /* ───────────────────────── 법령 참고 렌더 ───────────────────────── */
  function renderReference() {
    var data = window.SPC_LEGAL || [];
    var box = $('#referenceList');
    var meta = $('#referenceMeta');
    if (meta) meta.textContent = data.length + '개 조문';
    if (!box) return;
    var groups = [];
    var index = {};
    data.forEach(function (e) {
      if (!index[e.law]) { index[e.law] = { law: e.law, items: [] }; groups.push(index[e.law]); }
      index[e.law].items.push(e);
    });
    box.innerHTML = groups.map(function (g) {
      return '<div class="ref-group"><h3>' + esc(g.law) + '</h3><dl>' +
        g.items.map(function (i) {
          return '<dt>' + esc(i.article) + ' ' + esc(i.title) + '</dt><dd>' + esc(i.point) + '</dd>';
        }).join('') + '</dl></div>';
    }).join('');
  }

  /* ───────────────────────── 설정 모달 ───────────────────────── */
  var editingProvider = 'gemini';

  function openSettings() {
    var dlg = $('#settingsModal');
    if (!dlg) return;
    editingProvider = state.settings.provider;
    renderSettingsForm();
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
    var keyInput = $('#keyInput');
    if (keyInput) {
      setTimeout(function () {
        if (!state.settings.keys[editingProvider]) keyInput.focus();
      }, 80);
    }
  }

  function closeSettings() {
    var dlg = $('#settingsModal');
    if (!dlg) return;
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  function renderSettingsForm() {
    var p = editingProvider;
    $$('.provider-tab').forEach(function (t) {
      t.setAttribute('aria-selected', String(t.getAttribute('data-provider') === p));
    });
    var sel = $('#modelSelect');
    if (sel) {
      sel.innerHTML = PROVIDERS[p].models.map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>';
      }).join('');
      var saved = state.settings.models[p];
      var ok = PROVIDERS[p].models.some(function (m) { return m.id === saved; });
      sel.value = ok ? saved : PROVIDERS[p].models[0].id;
    }
    var keyInput = $('#keyInput');
    if (keyInput) {
      keyInput.value = state.settings.keys[p] || '';
      keyInput.type = 'password';
      keyInput.placeholder = p === 'gemini' ? 'AIza… 또는 AQ.…' : 'sk-…';
    }
    var toggle = $('#btnToggleKey');
    if (toggle) toggle.textContent = '보기';
    var savedState = $('#keySavedState');
    if (savedState) savedState.textContent = state.settings.keys[p] ? '· 저장된 키 있음' : '· 저장된 키 없음';
    var hint = $('#keyLinkHint');
    if (hint) {
      hint.innerHTML = PROVIDERS[p].keyHelp + ' <a href="' + PROVIDERS[p].keyUrl + '" target="_blank" rel="noopener">키 발급</a>';
    }
    setTest('', '');
  }

  function setTest(msg, kind) {
    var el = $('#testResult');
    if (!el) return;
    el.textContent = msg;
    el.className = 'test-result' + (kind ? ' ' + kind : '');
  }

  function verifyKey(provider, key) {
    if (provider === 'gemini') {
      return fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=50', {
        headers: { 'x-goog-api-key': key }
      }).then(function (res) {
        if (!res.ok) return describeError(res, provider).then(function (m) { throw new Error(m); });
        return res.json();
      }).then(function (j) {
        var names = (j.models || []).map(function (m) { return m.name || ''; });
        var hasFlash = names.some(function (n) { return /gemini-2\.5-flash/.test(n); });
        return '정상입니다. 사용 가능한 모델 ' + names.length + '개' + (hasFlash ? ' (gemini-2.5-flash 포함)' : '');
      });
    }
    return fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer ' + key }
    }).then(function (res) {
      if (!res.ok) return describeError(res, provider).then(function (m) { throw new Error(m); });
      return res.json();
    }).then(function (j) {
      var ids = (j.data || []).map(function (m) { return m.id; });
      var vision = ids.filter(function (id) { return /^gpt-4o/.test(id); });
      return '정상입니다. 사용 가능한 모델 ' + ids.length + '개' + (vision.length ? ' (' + vision.slice(0, 3).join(', ') + ')' : '');
    });
  }

  function testKey() {
    var keyInput = $('#keyInput');
    var key = keyInput ? keyInput.value.trim() : '';
    if (!key) { setTest('API 키를 입력하세요.', 'err'); return; }
    var btn = $('#btnTestKey');
    if (btn) btn.disabled = true;
    setTest('키를 확인하는 중…', 'wait');
    verifyKey(editingProvider, key).then(function (msg) {
      setTest(msg, 'ok');
    }).catch(function (err) {
      if (err instanceof TypeError) setTest('네트워크 오류로 확인하지 못했습니다. 인터넷 연결을 확인하세요.', 'err');
      else setTest(err.message || '키를 확인하지 못했습니다.', 'err');
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function saveKeyFromForm() {
    var keyInput = $('#keyInput');
    var sel = $('#modelSelect');
    state.settings.provider = editingProvider;
    state.settings.keys[editingProvider] = keyInput ? keyInput.value.trim() : '';
    if (sel && sel.value) state.settings.models[editingProvider] = sel.value;
    if (saveSettings()) {
      updateKeyStatus();
      closeSettings();
      toast(state.settings.keys[editingProvider] ? 'API 키를 저장했습니다' : '설정을 저장했습니다');
      if (state.photo) updateReadyStatus();
    }
  }

  function deleteKey() {
    if (!state.settings.keys[editingProvider]) { setTest('저장된 키가 없습니다.', 'err'); return; }
    if (!window.confirm(PROVIDERS[editingProvider].name + ' 키를 이 브라우저에서 삭제할까요?')) return;
    state.settings.keys[editingProvider] = '';
    saveSettings();
    renderSettingsForm();
    updateKeyStatus();
    toast('저장된 키를 삭제했습니다');
  }

  /* ───────────────────────── 이벤트 연결 ───────────────────────── */
  function bind() {
    // 설정
    var os = $('#btnOpenSettings');
    if (os) os.addEventListener('click', openSettings);
    var ns = $('#btnNoticeSettings');
    if (ns) ns.addEventListener('click', openSettings);
    $$('.provider-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        editingProvider = t.getAttribute('data-provider');
        renderSettingsForm();
      });
    });
    var toggle = $('#btnToggleKey');
    if (toggle) toggle.addEventListener('click', function () {
      var ki = $('#keyInput');
      if (!ki) return;
      var show = ki.type === 'password';
      ki.type = show ? 'text' : 'password';
      toggle.textContent = show ? '숨기기' : '보기';
      toggle.setAttribute('aria-label', show ? '키 숨기기' : '키 표시');
    });
    var tk = $('#btnTestKey');
    if (tk) tk.addEventListener('click', testKey);
    var sk = $('#btnSaveKey');
    if (sk) sk.addEventListener('click', saveKeyFromForm);
    var dk = $('#btnDeleteKey');
    if (dk) dk.addEventListener('click', deleteKey);

    // 사진
    var cam = $('#cameraInput');
    var fi = $('#fileInput');
    var bc = $('#btnCamera');
    var bp = $('#btnPick');
    var br = $('#btnReplace');
    var bd = $('#btnRemovePhoto');
    if (bc && cam) bc.addEventListener('click', function () { cam.click(); });
    if (bp && fi) bp.addEventListener('click', function () { fi.click(); });
    if (br && fi) br.addEventListener('click', function () { fi.click(); });
    if (bd) bd.addEventListener('click', function () { clearPhoto(); hideResult(); });
    [cam, fi].forEach(function (input) {
      if (!input) return;
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (f) processImage(f);
      });
    });

    // 드래그 앤 드롭
    var drop = $('#drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        drop.addEventListener(ev, function () { drop.classList.remove('is-over'); });
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('is-over');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) processImage(f);
      });
    }

    // 붙여넣기
    document.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) { processImage(f); break; }
        }
      }
    });

    // 공종
    var chips = $('#chips');
    if (chips) chips.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      selectWorkType(b.getAttribute('data-work'));
      if (state.photo) updateReadyStatus();
    });

    // 메모 카운터
    var memo = $('#memo');
    var mc = $('#memoCount');
    if (memo && mc) {
      mc.textContent = memo.value.length;
      memo.addEventListener('input', function () { mc.textContent = memo.value.length; });
    }

    // 판독
    var run = $('#btnAnalyze');
    if (run) run.addEventListener('click', analyze);

    // 결과 액션
    var copy = $('#btnCopy');
    if (copy) copy.addEventListener('click', function () {
      if (!state.result) return;
      var text = buildReport(state.result);
      copyText(text).then(function (ok) {
        if (ok) {
          toast('보고용 텍스트를 복사했습니다. 카톡·문서에 붙여넣으세요.');
          copy.textContent = '복사됨 ✓';
          setTimeout(function () { copy.textContent = '보고용 텍스트 복사'; }, 1800);
        } else {
          toast('복사하지 못했습니다. 인쇄·PDF를 이용해 주세요.', 'error');
        }
      });
    });
    var pr = $('#btnPrint');
    if (pr) pr.addEventListener('click', function () {
      var lb = $('#legalBox');
      if (lb) lb.open = true;
      setTimeout(function () { window.print(); }, 60);
    });
    var bn = $('#btnNew');
    if (bn) bn.addEventListener('click', function () {
      clearPhoto();
      hideResult();
      clearError();
      var memoEl = $('#memo');
      if (memoEl) { memoEl.value = ''; if (mc) mc.textContent = '0'; }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // 조치 체크
    var al = $('#actionsList');
    if (al) al.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'checkbox') {
        e.target.closest('li').classList.toggle('done', e.target.checked);
        var done = $$('#actionsList input[type="checkbox"]').filter(function (c) { return c.checked; }).length;
        if (state.result) state.result.actionsDone = done;
      }
    });

    // 히스토리
    var hl = $('#historyList');
    if (hl) hl.addEventListener('click', function (e) {
      var op = e.target.closest('[data-open]');
      var del = e.target.closest('[data-del]');
      if (op) openHistoryItem(op.getAttribute('data-open'));
      else if (del) removeHistoryItem(del.getAttribute('data-del'));
    });
    var ch = $('#btnClearHistory');
    if (ch) ch.addEventListener('click', function () {
      if (!window.confirm('저장된 점검 기록을 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
      try { localStorage.removeItem(LS_HISTORY); } catch (e) { /* noop */ }
      renderHistory();
      hideResult();
      toast('점검 기록을 모두 삭제했습니다');
    });

    // 인쇄 전 법령 근거 펼치기
    window.addEventListener('beforeprint', function () {
      var lb = $('#legalBox');
      if (lb) lb.open = true;
    });
  }

  /* ───────────────────────── 시작 ───────────────────────── */
  function init() {
    state.settings = loadSettings();
    renderChips();
    renderReference();
    renderHistory();
    bind();
    renderIdleStatus();
    updateKeyStatus();
    if (!currentKey()) {
      // 첫 방문자는 키 안내만 보여 주고 자동으로 모달을 열지 않는다.
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 개발·검증용 훅: ?debug=1 일 때만 노출되며 일반 사용에는 영향이 없습니다. */
  if (/[?&]debug=1/.test(location.search)) {
    window.__SPC_DEBUG = {
      normalizeResult: normalizeResult,
      renderResult: renderResult,
      buildReport: buildReport,
      analyze: analyze,
      state: state
    };
  }
})();
