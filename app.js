/* ============================================================
   Voca Study - Web 버전
   원본 tkinter 앱(m_logic.py / m_controller.py)의 로직을 그대로 포팅
   데이터 저장소: GitHub repo (Contents API, Personal Access Token)
   ============================================================ */

const LEVEL_COLORS = { 0: '#a6e3a1', 1: '#f9e2af', 2: '#89b4fa', '-1': '#f38ba8' };
const FILES = {
  dictionary: 'dictionary.json',
  scores: 'scores.json',
  deleted: 'deleted_words.json',
  weekly: 'weekly_stats.json',
};

/* ============================================================
   1. GitHub API 래퍼
   ============================================================ */
const GitHub = {
  cfg: null, // { owner, repo, branch, token }
  shaCache: {}, // path -> sha

  loadCfg() {
    const raw = localStorage.getItem('voca_github_cfg');
    this.cfg = raw ? JSON.parse(raw) : null;
    return this.cfg;
  },

  saveCfg(cfg) {
    this.cfg = cfg;
    localStorage.setItem('voca_github_cfg', JSON.stringify(cfg));
  },

  apiBase() {
    return `https://api.github.com/repos/${this.cfg.owner}/${this.cfg.repo}/contents`;
  },

  encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  },
  decode(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
  },

  async getFile(path) {
    const res = await fetch(`${this.apiBase()}/${path}?ref=${this.cfg.branch}`, {
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (res.status === 404) return { data: null, sha: null, notFound: true };
    if (!res.ok) throw new Error(`GET ${path} 실패: ${res.status} ${await res.text()}`);
    const json = await res.json();
    this.shaCache[path] = json.sha;
    return { data: JSON.parse(this.decode(json.content)), sha: json.sha };
  },

  async putFile(path, dataObj, message) {
    const body = {
      message,
      content: this.encode(JSON.stringify(dataObj, null, 2)),
      branch: this.cfg.branch,
    };
    if (this.shaCache[path]) body.sha = this.shaCache[path];

    let res = await fetch(`${this.apiBase()}/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 409 || res.status === 422) {
      // sha 충돌 -> 최신 sha 다시 받아서 재시도
      const fresh = await this.getFile(path);
      body.sha = fresh.sha;
      res = await fetch(`${this.apiBase()}/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) throw new Error(`PUT ${path} 실패: ${res.status} ${await res.text()}`);
    const json = await res.json();
    this.shaCache[path] = json.content.sha;
    return json;
  },

  async testConnection() {
    const res = await fetch(`https://api.github.com/repos/${this.cfg.owner}/${this.cfg.repo}`, {
      headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`저장소 접근 실패 (${res.status}). owner/repo/토큰 권한을 확인하세요.`);
    return true;
  },
};

/* ============================================================
   2. 저장 큐 (디바운스) - 파일별로 변경사항을 모아서 일정 시간 후 1번만 커밋
   ============================================================ */
const SaveQueue = {
  pending: {}, // path -> {data, message}
  timer: null,
  DELAY: 1500,

  schedule(path, data, message) {
    this.pending[path] = { data, message };
    setSyncStatus('pending', '저장 대기중...');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.DELAY);
  },

  async flush() {
    const entries = Object.entries(this.pending);
    if (entries.length === 0) return;
    this.pending = {};
    setSyncStatus('syncing', 'GitHub에 저장중...');
    try {
      for (const [path, { data, message }] of entries) {
        await GitHub.putFile(path, data, message);
      }
      setSyncStatus('ok', '저장됨');
    } catch (e) {
      console.error(e);
      setSyncStatus('error', '저장 실패 - 연결/토큰 확인 필요');
      showToast(e.message, true);
    }
  },

  async flushNow() {
    clearTimeout(this.timer);
    await this.flush();
  },
};

function setSyncStatus(state, text) {
  const ind = document.getElementById('sync-indicator');
  const txt = document.getElementById('sync-text');
  ind.classList.remove('syncing', 'error');
  if (state === 'syncing' || state === 'pending') ind.classList.add('syncing');
  if (state === 'error') ind.classList.add('error');
  txt.textContent = text;
}

/* ============================================================
   3. 로직 모듈 (m_logic.py 포팅)
   ============================================================ */
const Logic = {
  calculateWeight(star, x) {
    const w = 1.0 + star * 2.0 - x * 0.5;
    return Math.max(0.1, w);
  },

  updateItemWeight(item) {
    item.weight = this.calculateWeight(item.star || 0, item.x || 0);
  },

  mergeVocab(dictionary, scores) {
    const vocabList = dictionary.map((entry) => {
      const scoreData = scores[entry.word] || { star: 0, x: 0 };
      const merged = { ...entry, star: scoreData.star || 0, x: scoreData.x || 0 };
      this.updateItemWeight(merged);
      return merged;
    });
    return vocabList;
  },

  scoresFromVocab(vocabList) {
    const scores = {};
    for (const item of vocabList) scores[item.word] = { star: item.star, x: item.x };
    return scores;
  },

  selectWeightedRandom(vocabList) {
    if (!vocabList.length) return null;
    const totalWeight = vocabList.reduce((s, i) => s + i.weight, 0);
    if (totalWeight <= 0.5) return vocabList[Math.floor(Math.random() * vocabList.length)];
    let r = Math.random() * totalWeight;
    let cumulative = 0;
    for (const item of vocabList) {
      cumulative += item.weight;
      if (r <= cumulative) return item;
    }
    return vocabList[vocabList.length - 1];
  },

  addStar(item) {
    if (item.x > 0) item.x -= 1;
    else if (item.star < 5) item.star += 1;
    this.updateItemWeight(item);
  },
  removeStar(item) {
    if (item.star > 0) item.star -= 1;
    this.updateItemWeight(item);
  },
  addX(item) {
    if (item.star > 0) item.star -= 1;
    else if (item.x < 2) item.x += 1;
    this.updateItemWeight(item);
  },
  removeX(item) {
    if (item.x > 0) item.x -= 1;
    this.updateItemWeight(item);
  },

  getStats(vocabList) {
    const total = vocabList.length;
    const totalStars = vocabList.reduce((s, i) => s + i.star, 0);
    const totalX = vocabList.reduce((s, i) => s + i.x, 0);
    return { total, totalStars, totalX };
  },

  // 주차 키 계산: 원본 Python 알고리즘과 동일 (일요일 시작 기준)
  getCurrentWeekKey(d = new Date()) {
    const year = d.getFullYear();
    const yearInfo = String(year).slice(-2);
    const firstDay = new Date(year, 0, 1);
    const pyWeekday = (firstDay.getDay() + 6) % 7; // Mon=0..Sun=6
    let daysToSubtract = pyWeekday + 1;
    if (daysToSubtract === 7) daysToSubtract = 0;
    const firstSunday = new Date(year, 0, 1 - daysToSubtract);
    const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const daysDiff = Math.round((dateOnly - firstSunday) / 86400000);
    const weekNum = Math.floor(daysDiff / 7) + 1;
    return `${yearInfo}w${String(weekNum).padStart(2, '0')}`;
  },

  updateWeeklyStats(weeklyStats, weekKey, word) {
    if (!weeklyStats[weekKey]) weeklyStats[weekKey] = { reviewed_words: [], total: 0 };
    if (!weeklyStats[weekKey].reviewed_words.includes(word)) {
      weeklyStats[weekKey].reviewed_words.push(word);
      weeklyStats[weekKey].total = weeklyStats[weekKey].reviewed_words.length;
      return true; // 변경됨
    }
    return false;
  },

  formatExamples(collocations) {
    if (!collocations || !collocations.length) return '(예문 없음)';
    const texts = [];
    for (const coll of collocations) {
      const phrase = coll.phrase || '';
      const example = coll.example || '';
      if (phrase && example) texts.push(`• ${phrase}\n  ${example}`);
      else if (phrase) texts.push(`• ${phrase}`);
      else if (example) texts.push(example);
    }
    return texts.join('\n\n');
  },
};

/* ============================================================
   4. 컨트롤러 / 상태
   ============================================================ */
const State = {
  vocabList: [],
  currentWord: null,
  scores: {},
  deletedWords: { words: [] },
  weeklyStats: {},
};

function getCurrentItem() {
  if (State.currentWord) {
    const item = State.vocabList.find((i) => i.word === State.currentWord);
    if (item) return item;
  }
  if (State.vocabList.length) {
    State.currentWord = State.vocabList[0].word;
    return State.vocabList[0];
  }
  return null;
}

function persistScores(message) {
  State.scores = Logic.scoresFromVocab(State.vocabList);
  SaveQueue.schedule(FILES.scores, State.scores, message);
}

function persistWeekly(message) {
  SaveQueue.schedule(FILES.weekly, State.weeklyStats, message);
}

function touchWeekly(word) {
  const weekKey = Logic.getCurrentWeekKey();
  const changed = Logic.updateWeeklyStats(State.weeklyStats, weekKey, word);
  if (changed) persistWeekly(`week ${weekKey}: review ${word}`);
}

function nextWord() {
  if (!State.vocabList.length) {
    showToast('표시할 단어가 없습니다.', true);
    return;
  }
  const selected = Logic.selectWeightedRandom(State.vocabList);
  State.currentWord = selected.word;
  touchWeekly(State.currentWord);
  render();
}

function addStar() {
  const item = getCurrentItem();
  if (!item) return;
  Logic.addStar(item);
  persistScores(`★+ ${item.word}`);
  touchWeekly(item.word);
  render();
}
function removeStar() {
  const item = getCurrentItem();
  if (!item) return;
  Logic.removeStar(item);
  persistScores(`★- ${item.word}`);
  touchWeekly(item.word);
  render();
}
function addX() {
  const item = getCurrentItem();
  if (!item) return;
  Logic.addX(item);
  persistScores(`X+ ${item.word}`);
  touchWeekly(item.word);
  render();
}
function removeX() {
  const item = getCurrentItem();
  if (!item) return;
  Logic.removeX(item);
  persistScores(`X- ${item.word}`);
  touchWeekly(item.word);
  render();
}

async function copyWord() {
  const item = getCurrentItem();
  if (!item) return;
  try {
    await navigator.clipboard.writeText(item.word);
  } catch (e) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = item.word;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showStatus(`📋 '${item.word}' 복사됨`);
}

function deleteCurrentWord() {
  const item = getCurrentItem();
  if (!item) return;
  showConfirm(`'${item.word}' 단어를 딕셔너리에서 삭제하시겠습니까?`, () => {
    State.deletedWords.words.push({
      word: item.word,
      original_level: item.level,
      deleted_at: new Date().toISOString(),
    });
    SaveQueue.schedule(FILES.deleted, State.deletedWords, `delete ${item.word}`);

    delete State.scores[item.word];
    SaveQueue.schedule(FILES.scores, State.scores, `remove score ${item.word}`);

    State.vocabList = State.vocabList.filter((i) => i.word !== item.word);
    // dictionary.json은 외부에서도 계속 보강되는 데이터셋이므로,
    // 캐시된 옛 버전을 덮어쓰지 않고 항상 GitHub 최신본을 다시 받아 그 위에서 삭제만 적용한다.
    scheduleDictionaryDelete(item.word);

    if (State.vocabList.length) {
      State.currentWord = State.vocabList[Math.floor(Math.random() * State.vocabList.length)].word;
      showStatus(`🗑️ '${State.currentWord}' 로 이동`);
    } else {
      State.currentWord = null;
      showStatus('⚠️ 모든 단어가 삭제되었습니다.');
    }
    render();
  });
}

let dictionaryCache = null; // 원본 dictionary.json raw (star/x 없는 형태) - 화면 표시/병합용 로컬 참조

// 삭제 예정 단어 모음 + 디바운스 타이머 (dictionary.json 전용 - 안전한 merge-on-write)
const PendingDictDeletes = new Set();
let dictDeleteTimer = null;

function scheduleDictionaryDelete(word) {
  PendingDictDeletes.add(word);
  setSyncStatus('pending', '단어 삭제 저장 대기중...');
  clearTimeout(dictDeleteTimer);
  dictDeleteTimer = setTimeout(flushDictionaryDeletes, 1500);
}

async function flushDictionaryDeletes() {
  if (PendingDictDeletes.size === 0) return;
  const words = new Set(PendingDictDeletes);
  PendingDictDeletes.clear();
  setSyncStatus('syncing', 'dictionary.json 최신본을 받아 삭제 반영중...');
  try {
    // 항상 GitHub의 "현재" dictionary.json을 다시 받아온 뒤 그 위에서 삭제만 적용한다.
    // 이렇게 해야 외부에서 그 사이에 보강/추가된 다른 단어 내용이 보존된다.
    const fresh = await GitHub.getFile(FILES.dictionary);
    const latest = fresh.notFound ? [] : fresh.data;
    const updated = latest.filter((entry) => !words.has(entry.word));
    dictionaryCache = updated;
    await GitHub.putFile(FILES.dictionary, updated, `delete words: ${[...words].join(', ')}`);
    setSyncStatus('ok', '삭제 반영됨');
  } catch (e) {
    console.error(e);
    setSyncStatus('error', '단어 삭제 저장 실패');
    showToast(e.message, true);
    words.forEach((w) => PendingDictDeletes.add(w)); // 재시도를 위해 복구
  }
}

/* ============================================================
   5. 렌더링
   ============================================================ */
function getStarXBadge(star, x) {
  const parts = [];
  if (star > 0) parts.push(`★${star}`);
  if (x > 0) parts.push(`❌${x}`);
  return parts;
}

function render() {
  const item = getCurrentItem();
  if (!item) {
    document.getElementById('word').textContent = '단어가 없습니다';
    document.getElementById('definition').textContent = '';
    document.getElementById('examples').textContent = '(예문 없음)';
    return;
  }

  const wordEl = document.getElementById('word');
  wordEl.textContent = item.word;
  wordEl.style.color = LEVEL_COLORS[String(item.level)] || 'var(--text-primary)';

  const [starText, xText] = (() => {
    const badges = getStarXBadge(item.star, item.x);
    return [badges.find((b) => b.startsWith('★')) || '', badges.find((b) => b.startsWith('❌')) || ''];
  })();
  const starBadge = document.getElementById('star-badge');
  const xBadge = document.getElementById('x-badge');
  starBadge.textContent = starText;
  starBadge.classList.toggle('hidden', !starText);
  xBadge.textContent = xText;
  xBadge.classList.toggle('hidden', !xText);

  document.getElementById('pron').textContent = item.pronunciation || '';
  document.getElementById('level').textContent = `L${item.level}`;

  const koDef = item.ko_definition && item.ko_definition.trim();
  document.getElementById('definition').textContent = koDef ? `${item.definition} (${koDef})` : item.definition || '';

  document.getElementById('examples').textContent = Logic.formatExamples(item.collocations);

  const starDisplay = `${'★'.repeat(item.star)}${'☆'.repeat(5 - item.star)}  ${'❌'.repeat(item.x)}${'○'.repeat(2 - item.x)}`;
  document.getElementById('star-display').textContent = starDisplay;

  const stats = Logic.getStats(State.vocabList);
  const weekKey = Logic.getCurrentWeekKey();
  const weeklyTotal = (State.weeklyStats[weekKey] && State.weeklyStats[weekKey].total) || 0;
  document.getElementById('footer-text').textContent =
    `${stats.total}개 | ⭐${stats.totalStars} | ❌${stats.totalX}    📅 ${weekKey} | ${weeklyTotal}개 리뷰`;
}

let statusTimer = null;
function showStatus(text) {
  const el = document.getElementById('status-text');
  el.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

function showToast(text, isError = false) {
  const container = document.getElementById('toast-container');
  const div = document.createElement('div');
  div.className = 'toast' + (isError ? ' error' : '');
  div.textContent = text;
  container.appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

function showConfirm(text, onYes) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-text').textContent = text;
  modal.classList.remove('hidden');
  const yes = document.getElementById('confirm-yes');
  const no = document.getElementById('confirm-no');
  const cleanup = () => {
    modal.classList.add('hidden');
    yes.removeEventListener('click', onYesClick);
    no.removeEventListener('click', onNoClick);
  };
  const onYesClick = () => { cleanup(); onYes(); };
  const onNoClick = () => cleanup();
  yes.addEventListener('click', onYesClick);
  no.addEventListener('click', onNoClick);
}

/* ============================================================
   6. 초기화 / 동기화
   ============================================================ */
let isLoading = false;

async function loadAllData(label = 'GitHub에서 불러오는 중...') {
  isLoading = true;
  setSyncStatus('syncing', label);

  const [dictRes, scoresRes, deletedRes, weeklyRes] = await Promise.all([
    GitHub.getFile(FILES.dictionary),
    GitHub.getFile(FILES.scores),
    GitHub.getFile(FILES.deleted),
    GitHub.getFile(FILES.weekly),
  ]);

  if (dictRes.notFound) throw new Error('dictionary.json 을 저장소에서 찾을 수 없습니다. 저장소 루트에 업로드했는지 확인하세요.');

  dictionaryCache = dictRes.data;
  State.scores = scoresRes.notFound ? {} : scoresRes.data;
  State.deletedWords = deletedRes.notFound ? { words: [] } : deletedRes.data;
  State.weeklyStats = weeklyRes.notFound ? {} : weeklyRes.data;

  State.vocabList = Logic.mergeVocab(dictionaryCache, State.scores);

  // scores.json 이 없었거나 내용이 vocabList 와 다르면 한 번 동기화 저장
  const recomputed = Logic.scoresFromVocab(State.vocabList);
  if (scoresRes.notFound || JSON.stringify(recomputed) !== JSON.stringify(State.scores)) {
    State.scores = recomputed;
    SaveQueue.schedule(FILES.scores, State.scores, 'sync scores');
  }

  isLoading = false;
  setSyncStatus('ok', `${State.vocabList.length}개 단어 로드됨`);
}

function hasPendingChanges() {
  return Object.keys(SaveQueue.pending).length > 0 || PendingDictDeletes.size > 0;
}

async function flushAllPending() {
  await Promise.all([SaveQueue.flushNow(), flushDictionaryDeletes()]);
}

// 다른 기기에서 수정한 내용을 반영 (현재 보고 있는 단어는 그대로 유지, 없어졌으면 다음 단어로)
async function reloadFromGitHub({ silent = false } = {}) {
  if (isLoading) return;
  if (hasPendingChanges()) {
    if (!silent) showStatus('저장 중인 변경사항을 먼저 GitHub에 올리는 중...');
    await flushAllPending();
  }
  const keepWord = State.currentWord;
  try {
    await loadAllData(silent ? '다른 기기 변경사항 확인중...' : 'GitHub에서 새로 불러오는 중...');
    State.currentWord = State.vocabList.some((i) => i.word === keepWord) ? keepWord : null;
    if (!State.currentWord) nextWord();
    else render();
    if (!silent) showStatus('✅ 최신 데이터로 갱신됨');
  } catch (e) {
    console.error(e);
    setSyncStatus('error', '새로고침 실패');
    if (!silent) showToast(e.message, true);
  }
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const key = e.key.toLowerCase();
    const handlers = {
      arrowright: nextWord,
      ' ': nextWord,
      '+': addStar,
      '=': addStar,
      '-': removeStar,
      x: addX,
      c: removeX,
      r: removeStar,
      v: copyWord,
    };
    if (handlers[key]) {
      e.preventDefault();
      handlers[key]();
    }
  });
}

function bindUIEvents() {
  document.getElementById('next-btn').addEventListener('click', nextWord);
  document.getElementById('copy-btn').addEventListener('click', copyWord);
  document.getElementById('delete-btn').addEventListener('click', deleteCurrentWord);
  document.querySelectorAll('[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    const map = { 'add-star': addStar, 'remove-star': removeStar, 'add-x': addX, 'remove-x': removeX };
    btn.addEventListener('click', map[action]);
  });
  document.getElementById('refresh-btn').addEventListener('click', () => reloadFromGitHub());
  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('setup-modal').classList.remove('hidden');
    prefillSetupForm();
  });

  // 모바일에서는 beforeunload가 신뢰성이 낮으므로, 탭이 백그라운드로 갈 때(visibilitychange)
  // 즉시 저장을 시도한다. pagehide도 함께 등록해 iOS Safari 대응.
  const flushOnHide = () => {
    if (hasPendingChanges()) flushAllPending();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushOnHide();
    } else if (document.visibilityState === 'visible') {
      // 다시 돌아왔을 때: 보류중인 저장이 없다면 다른 기기에서 바뀐 내용이 있는지 조용히 확인
      if (!isLoading) reloadFromGitHub({ silent: true });
    }
  });
  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('beforeunload', flushOnHide);
}

function prefillSetupForm() {
  const cfg = GitHub.cfg;
  if (!cfg) return;
  document.getElementById('input-owner').value = cfg.owner || '';
  document.getElementById('input-repo').value = cfg.repo || 'vaca_study';
  document.getElementById('input-branch').value = cfg.branch || 'main';
  document.getElementById('input-token').value = cfg.token || '';
}

async function startApp() {
  document.getElementById('setup-modal').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  try {
    await loadAllData();
    nextWord();
  } catch (e) {
    console.error(e);
    setSyncStatus('error', '로드 실패');
    showToast(e.message, true);
  }
}

function setupSetupModal() {
  const saveBtn = document.getElementById('setup-save-btn');
  const errEl = document.getElementById('setup-error');
  saveBtn.addEventListener('click', async () => {
    const owner = document.getElementById('input-owner').value.trim();
    const repo = document.getElementById('input-repo').value.trim() || 'vaca_study';
    const branch = document.getElementById('input-branch').value.trim() || 'main';
    const token = document.getElementById('input-token').value.trim();

    if (!owner || !token) {
      errEl.textContent = 'GitHub 사용자명과 토큰을 입력하세요.';
      errEl.classList.remove('hidden');
      return;
    }

    GitHub.saveCfg({ owner, repo, branch, token });
    saveBtn.disabled = true;
    saveBtn.textContent = '연결 확인중...';
    errEl.classList.add('hidden');
    try {
      await GitHub.testConnection();
      startApp();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '저장하고 시작하기';
    }
  });
}

function init() {
  bindUIEvents();
  setupKeyboardShortcuts();
  setupSetupModal();

  const cfg = GitHub.loadCfg();
  if (cfg && cfg.owner && cfg.token) {
    startApp();
  } else {
    document.getElementById('setup-modal').classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', init);
