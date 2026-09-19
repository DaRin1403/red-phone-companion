/**
 * phone-replies.mjs —— 监听 DSH 会话，在"我那一轮回复完成"时通知电话响铃
 *
 * 为什么不用现成 hook：DSH 没有 Codex 那样的 Stop Hook，
 * 所以改为**只读监听会话文件**。实测结论（见 工具/会话探测.py）：
 *   · 会话存为 session.jsonl.zstd，是**多 frame 拼接**的 zstd 文件
 *   · Node 的 zstdDecompressSync 只解第一个 frame，会漏掉全部内容
 *   · 但 zstd frame 有固定魔数 28 B5 2F FD，按魔数切开逐个解压 → 实测 5848 帧全成功
 *   · turn/end 事件的 data.reason.kind === 'completed' 就是"这一轮说完了"的可靠标志
 *   · 一个回合可能有多条 assistant/message（分步产出），最后一条才是最终答复
 *
 * 设计约束：
 *   1. **只在电话发起的回合之后才响铃** —— 用户自己打字时不该被电话打扰。
 *      实现方式：进入等待状态时记录一个时间下界，之后完成的回合才算数。
 *   2. 只读，绝不写会话文件，避免污染 DSH 状态。
 */
import { EventEmitter } from 'node:events';
import { statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出 buffer 里所有 zstd frame 的起点 */
export function findFrames(buf) {
  const starts = [];
  let idx = 0;
  while ((idx = buf.indexOf(ZSTD_MAGIC, idx)) !== -1) {
    starts.push(idx);
    idx += 4;
  }
  return starts;
}

/**
 * 按 frame 切分并解压，返回解压后的 utf8 文本。
 * 最后一个 frame 可能还在写入（不完整），解压失败会被跳过而不报错。
 * @returns {{text: string, frames: number, failed: number}}
 */
export function decompressSession(buf) {
  const starts = findFrames(buf);
  if (!starts.length) return { text: '', frames: 0, failed: 0 };
  const parts = [];
  let failed = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)));
    } catch {
      failed += 1;                      // 多半是正在写的最后一帧
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length, failed };
}

/**
 * 解析解压后的 JSONL，抽出我们关心的事件。
 * @returns {{turns: Array<{turn,endedAt,completed,reply}>,
 *            userTexts: string[],
 *            userTurns: Array<{turn:number|null, text:string}>}}
 *   userTexts 是用户发过的消息文本（按顺序）；
 *   userTurns 额外带上"这条消息属于哪一轮" —— 用户消息事件本身**没有** turn 字段，
 *   所以按事件顺序挂在最近一次 turn/start 上。回铃要靠它认准"该等哪一轮完成"。
 */
export function parseEvents(text) {
  const turns = new Map();
  const order = [];
  const userTexts = [];
  const userTurns = [];
  let currentTurn = null;
  const slot = (turn) => {
    if (!turns.has(turn)) {
      const s = { turn, endedAt: null, completed: false, reply: '', lastSeq: -1 };
      turns.set(turn, s);
      order.push(s);
    }
    return turns.get(turn);
  };

  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = obj.type;
    const data = obj.data ?? {};

    if (type === 'turn/start') {
      if (typeof data.turn === 'number') currentTurn = data.turn;
      const s = slot(data.turn);
      if (s) continue;
    }

    // 用户消息没有 turn 字段（实测），所以单独收集出来：
    // "按内容定位会话"和"该等哪一轮"都要靠它 ——
    // 只有 user/message 才代表"这句话真的被人说给了这个会话"。
    if (type === 'user/message') {
      const t = extractText(data.content);
      if (t) {
        userTexts.push(t);
        userTurns.push({ turn: currentTurn, text: t });
      }
      continue;
    }

    const turn = data.turn;
    if (typeof turn !== 'number') continue;

    if (type === 'turn/end') {
      const s = slot(turn);
      s.endedAt = typeof obj.time === 'number' ? obj.time : Date.now();
      s.completed = data.reason?.kind === 'completed';
    } else if (type === 'assistant/message') {
      const seq = typeof obj.seq === 'number' ? obj.seq : 0;
      const s = slot(turn);
      if (seq >= s.lastSeq) {
        s.reply = extractText(data.message?.content);
        s.lastSeq = seq;
      }
    }
  }
  return { turns: order, userTexts, userTurns };
}

/** 从 message.content（str 或 block 数组）里取出纯文本 */
export function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block && typeof block === 'object') {
      if (typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.content === 'string') parts.push(block.content);
    }
  }
  return parts.join('');
}

/**
 * 定位会话文件。
 *
 * DSH 的实际结构是：<sessions>/<工作区编码目录>/<会话id>/session.jsonl.zstd
 * 也就是说**会话文件在会话 id 子目录里，不在工作区目录下**。
 * 一个工作区下会有很多历史会话，取最近写入的那个（当前会话一直在写）。
 *
 * @param {string} dirOrRoot 工作区编码目录，或已含 session.jsonl.zstd 的会话目录
 * @returns {string|null}
 */
export function resolveSessionFile(dirOrRoot) {
  if (!dirOrRoot) return null;
  const direct = join(dirOrRoot, 'session.jsonl.zstd');
  if (existsSync(direct)) return direct;              // 已经是会话 id 目录
  if (!existsSync(dirOrRoot)) return null;
  let best = null;
  for (const entry of readdirSync(dirOrRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dirOrRoot, entry.name, 'session.jsonl.zstd');
    if (!existsSync(file)) continue;
    let m = 0;
    try { m = statSync(file).mtimeMs; } catch { continue; }
    if (!best || m > best.m) best = { m, file };
  }
  return best ? best.file : null;
}

/**
 * 找出"收下这句话"的会话文件，**以及这句话属于哪一轮**。
 *
 * 为什么要按内容找会话：一个工作区下会有很多会话，而且**可能有好几个同时在写**
 * （用户开着多个标签页）。监听器启动时只能按"最后写入时间"挑一个 ——
 * 挑错的后果是盯着别人的会话等回复，又变成"我回复完电话不响"。
 * 而"刚注入的那句话落在哪份会话里"是唯一可靠的判据。
 *
 * 为什么还要回合号：用户在**我还没回复完**的时候又说了一句时，
 * 如果只按"下一个完成的回合"响铃，这次等待会被那条**正在生成中**的回复消耗掉，
 * 真正属于用户的那一轮完成时反而不会响（真机上踩过，见 followText 的注释）。
 *
 * @param {string} dirOrRoot 工作区编码目录，或已含 session.jsonl.zstd 的会话目录
 * @param {string} text      刚注入的文字（传入清洗后的实际文本）
 * @param {object} [opts]
 * @param {number} [opts.scan] 只查最近写入的 N 个会话，避免每次都解压整个目录
 * @returns {{file: string, turn: number|null}|null}
 */
export function findSessionAndTurnContaining(dirOrRoot, text, { scan = 6 } = {}) {
  if (!dirOrRoot) return null;
  const needle = typeof text === 'string' ? text.trim() : '';
  if (!needle) return null;

  const wrap = (file, turn) => (file ? { file, turn: typeof turn === 'number' ? turn : null } : null);

  // 传进来的本身就是某个会话目录
  const direct = join(dirOrRoot, 'session.jsonl.zstd');
  if (existsSync(direct)) {
    const r = locateInFile(direct, needle);
    return r ? wrap(direct, r.turn) : null;
  }
  if (!existsSync(dirOrRoot)) return null;

  const files = [];
  let entries;
  try { entries = readdirSync(dirOrRoot, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dirOrRoot, entry.name, 'session.jsonl.zstd');
    if (!existsSync(file)) continue;
    let m = 0;
    try { m = statSync(file).mtimeMs; } catch { continue; }
    files.push({ m, file });
  }
  files.sort((a, b) => b.m - a.m);       // 最近的优先，够用了就不必扫全目录

  for (const { file } of files.slice(0, scan)) {
    const r = locateInFile(file, needle);
    if (r) return wrap(file, r.turn);
  }
  return null;
}

/** 兼容旧调用：只要文件路径 */
export function findSessionContaining(dirOrRoot, text, opts = {}) {
  const r = findSessionAndTurnContaining(dirOrRoot, text, opts);
  return r ? r.file : null;
}

/**
 * 在这份会话里找这句话，返回 { turn }（turn 可能为 null —— 找到了但认不出轮次）。
 * 找不到返回 null。
 */
function locateInFile(file, needle) {
  let text;
  try {
    text = decompressSession(readFileSync(file)).text;
  } catch {
    return null;
  }

  // ⚠️ 只跟"用户消息"比对，不能拿整份 JSONL 做子串匹配。
  // 会话里到处都是可能撞上的文本：工具调用的参数、工具输出、引用别人说的话……
  // 实测就被自己坑过：查一句"绝对不存在的话"，结果因为这句话出现在本工具的
  // 命令行参数里（而被记进了会话），把当前会话也算命中了。
  // 而真正要判断的是"这句话被当成用户消息收下了没有"，只有 user/message 算数。
  const norm = (s) => String(s).replace(/\s+/g, '');
  const target = norm(needle);
  if (!target) return null;
  const head = target.slice(0, 8);              // 末尾有细微差异时的兜底

  // ⚠️ **从最新往旧找**，不能从头往后找。
  //    短的注入文本很容易和旧消息撞上：真机上出现过"我。"——
  //    它既是刚注入的那句，也出现在更早的"测试测试123我。23喂喂喂"里，
  //    从头往后找就锁到了那句旧的回合上，等待回合号彻底错位。
  //    我们刚注入的内容一定是最新那条，所以"最后一次出现"才是对的。
  const entries = parseEvents(text).userTurns;
  for (let i = entries.length - 1; i >= 0; i--) {
    const n = norm(entries[i].text);
    if (!n) continue;
    if (n.includes(target)) return { turn: entries[i].turn };
    if (head.length >= 6 && n.includes(head)) return { turn: entries[i].turn };
  }
  return null;
}

/**
 * 会话监听器：轮询会话文件，检测"已完成且开始时间晚于下界"的回合。
 *
 * @param {object} opts
 * @param {string} opts.sessionDir   会话根目录（工作区编码目录）或会话 id 目录
 * @param {number} [opts.pollMs]     轮询间隔，默认 1000
 */
export class SessionWatcher extends EventEmitter {
  constructor({ sessionDir, pollMs = 1000, sessionFile = null, autoResolve = true } = {}) {
    super();
    this.sessionDir = sessionDir;
    this.sessionFile = sessionFile
      ?? (autoResolve ? resolveSessionFile(sessionDir) : (sessionDir ? join(sessionDir, 'session.jsonl.zstd') : null));
    this.pollMs = pollMs;
    this._timer = null;
    this._lastSize = -1;
    this._lastMtime = 0;
    this._seenTurns = new Set();       // 已处理过的回合号，防重复触发
    this._armed = false;               // 是否处于"等回复"状态
    this._armedAt = 0;                 // 等待开始的时间下界（毫秒）
    this._locateText = null;           // 刚注入的文字，用来确认该盯哪个会话
    this._locateUntil = 0;
    this._expectTurn = null;           // 该等哪一轮完成（电话注入的那句话所在回合）
    this.stats = { polls: 0, decodes: 0, completions: 0, relocates: 0, lastError: null };
  }

  /** 开始等待一次回复：记录时间下界，之后完成的回合才触发 */
  arm() {
    this._armed = true;
    this._armedAt = Date.now();
    this._expectTurn = null;           // 新的一次等待，先不锁定回合（followText 会补上）
    this.emit('armed', { at: this._armedAt });
    return this._armedAt;
  }

  /** 取消等待（例如用户主动放弃） */
  disarm() {
    this._armed = false;
    this._expectTurn = null;
    this.emit('disarmed');
  }

  /**
   * 记下"刚刚注入给 DSH 的那句话"，稍后在轮询里据此确认/切换会话文件。
   *
   * 场景：用户开着多个标签页时，多份会话文件同时在被写入，
   * 按"最后写入时间"挑会话可能挑错 —— 挑错就盯着别人的会话等回复，
   * 表现还是"我回复完电话不响"。按内容定位是唯一可靠的判据。
   *
   * @param {string} text 注入的实际文本
   * @param {object} [opts]
   * @param {number} [opts.windowMs] 多久之内没找到就放弃（默认 90 秒）
   */
  followText(text, { windowMs = 90000 } = {}) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return;
    this._locateText = t;
    this._locateUntil = Date.now() + windowMs;
    this._expectTurn = null;         // 还没定位到，先不锁定回合
  }

  /** 按 _locateText 重新定位会话 + 锁定"该等哪一轮"（找到就切过去；没找到等下次轮询） */
  _maybeRelocate() {
    if (!this._locateText) return;
    if (Date.now() > this._locateUntil) {      // 一直没找到（可能被清洗改过），别一直扫
      this._locateText = null;
      return;
    }

    // ⚠️ 即使会话文件没变，也要试着把回合号找出来 —— 它才是"该等哪一轮"的判据。
    let found = null;
    try {
      found = findSessionAndTurnContaining(this.sessionDir, this._locateText);
    } catch {
      return;
    }
    if (!found) return;

    this._locateText = null;
    if (typeof found.turn === 'number') this._expectTurn = found.turn;

    if (found.file !== this.sessionFile) {
      this._switchTo(found.file, '按刚注入的文字重新定位会话');
    } else if (typeof found.turn === 'number') {
      this.emit('log', { msg: `已锁定等待回合：第 ${found.turn} 轮（电话注入的那句话所在回合）` });
    }
  }

  /**
   * 换到另一个会话文件。
   *
   * ⚠️ 换会话时**必须清空 _seenTurns**：回合号只在同一个会话里有意义，
   * 拿甲会话的"第 30 回合"去比乙会话的"第 30 回合"，会漏报或误报。
   * 清空后重新把新会话里"已完成"的回合标记为已见（未完成的不标，见 start 的注释）。
   */
  _switchTo(file, why) {
    if (!file || file === this.sessionFile) return false;
    const from = this.sessionFile;
    this.sessionFile = file;
    this._lastSize = -1;
    this._lastMtime = 0;
    this._seenTurns = new Set();
    const info = this._primeSeen();
    this.stats.relocates += 1;
    this.emit('log', {
      msg: `${why}：${from ? basename(dirname(from)) : '（无）'} → ${basename(dirname(file))}`
        + `（${info.turns} 回合，已完成 ${info.completed}）`,
    });
    return true;
  }

  /**
   * 把当前会话文件里"已经完成"的回合记为已见。
   * 只标已完成的 —— 未完成的那个回合等它真正完成时要能被检测到。
   */
  _primeSeen() {
    const snapshot = this._readAll();
    let completed = 0;
    for (const t of snapshot.turns) {
      if (t.completed) { this._seenTurns.add(t.turn); completed += 1; }
    }
    return { turns: snapshot.turns.length, completed, seen: this._seenTurns.size };
  }

  get armed() { return this._armed; }

  start() {
    if (this._timer) return this;
    // 启动时先跑一次与轮询完全相同的路径：这样 _lastSize/_lastMtime 会被正确写入，
    // 且历史回合一次性全部标记为已见。
    // （早期实现直接在 start() 里 _readAll() 而不更新缓存，结果第一次 poll()
    //   会误判"文件变了"再解压一遍 —— 3MB 的会话文件白解一次。）
    try {
      // ⚠️ 只能把"已经完成"的回合标记为已见。
      // 早先这里无差别地把所有回合都标记了，包括那个"正在进行、尚未完成"的当前回合 ——
      // 结果它真正完成时被当成"见过了"直接跳过，永远检测不到完成。
      // 这个 bug 在离线测试里测不出来（测试文件里的事件都是完整的），真机上必现。
      const info = this._primeSeen();
      if (this.sessionFile && existsSync(this.sessionFile)) {
        const st = statSync(this.sessionFile);
        this._lastSize = st.size;
        this._lastMtime = st.mtimeMs;
      }
      this.emit('ready', {
        turns: info.turns, seen: info.seen, completed: info.completed,
      });
    } catch (err) {
      this.stats.lastError = String(err?.message ?? err);
    }
    this._timer = setInterval(() => {
      this.poll().catch((err) => {
        this.stats.lastError = String(err?.message ?? err);
        this.emit('error', err);
      });
    }, this.pollMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _readAll() {
    if (!this.sessionFile || !existsSync(this.sessionFile)) {
      return { turns: [], frames: 0, failed: 0 };
    }
    const buf = readFileSync(this.sessionFile);
    const { text, frames, failed } = decompressSession(buf);
    this.stats.decodes += 1;
    return { ...parseEvents(text), frames, failed };
  }

  /** 轮询一次；有新回合完成且处于等待状态时发出 reply-completed 事件 */
  async poll() {
    this.stats.polls += 1;

    // 刚注入过文字：先确认该盯哪个会话（多标签页时按"最后写入时间"挑可能挑错）
    this._maybeRelocate();

    // 会话切换（例如用户开了新会话）时，原来那个文件会停止写入。
    // 这里在文件不存在、或已长时间没更新时重新解析一次，自动跟上当前会话。
    if (!this.sessionFile || !existsSync(this.sessionFile)) {
      const again = resolveSessionFile(this.sessionDir);
      if (again && again !== this.sessionFile) {
        this.sessionFile = again;
        this._lastSize = -1;
        this._lastMtime = 0;
        this.emit('log', { msg: `切换到会话文件 ${again}` });
      } else if (!again) {
        return null;
      }
    }
    if (!this.sessionFile || !existsSync(this.sessionFile)) return null;

    let st;
    try { st = statSync(this.sessionFile); } catch { return null; }
    const size = st.size;
    const mtime = st.mtimeMs;
    if (size === this._lastSize && mtime === this._lastMtime) return null;   // 没变化，省一次解压
    this._lastSize = size;
    this._lastMtime = mtime;

    const { turns, frames, failed } = this._readAll();
    if (failed) this.emit('warn', { where: 'sessionDecode', failed, frames });

    let fired = null;
    for (const t of turns) {
      if (this._seenTurns.has(t.turn)) continue;
      if (!t.completed) continue;
      this._seenTurns.add(t.turn);
      if (!this._armed) continue;                       // 不在等回复，只记录不响铃
      if (t.endedAt && t.endedAt < this._armedAt) continue;  // 早于本次等待，是旧回合
      // ⚠️ 已经锁定"该等哪一轮"时，早于它的回合一律不算。
      //    场景：用户在我还没回复完的时候又说了一句 —— 那次等待如果被
      //    "正在生成中的那条回复"消耗掉，真正属于用户的那一轮完成时就不会响铃了。
      //    真机上踩过：明明说了话，却因为上一条回复刚好结束而提前响掉。
      if (this._expectTurn !== null && t.turn < this._expectTurn) continue;
      fired = t;
    }
    if (fired) {
      this._armed = false;
      this._expectTurn = null;
      this.stats.completions += 1;
      this.emit('reply-completed', {
        turn: fired.turn,
        reply: fired.reply,
        chars: fired.reply.length,
        endedAt: fired.endedAt,
      });
    }
    return fired;
  }

  /**
   * 等待一次回复完成（Promise 版，便于在状态机里 await）。
   * @param {object} opts
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   */
  waitForReply({ timeoutMs = 600000, signal = null } = {}) {
    this.arm();
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.off('reply-completed', onDone);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onDone = (info) => { cleanup(); resolve(info); };
      const onAbort = () => { cleanup(); this.disarm(); reject(new Error('已取消等待回复')); };
      this.once('reply-completed', onDone);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        this.disarm();
        reject(new Error(`等待回复超时（${timeoutMs}ms）`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
  }
}

/** 推算某工作目录对应的 DSH 会话目录（DSH 用路径转义成目录名） */
export function sessionDirForWorkspace(workspacePath, sessionsRoot) {
  if (!workspacePath || !sessionsRoot) return null;
  let esc = workspacePath.replace(/[\\/:]/g, (m) => {
    if (m === '\\') return '\\';
    return m;
  });
  // DSH 的转义规则：盘符冒号 → ~0020 之类的编码；这里按实测样本构造
  const drive = workspacePath.match(/^([A-Za-z]):\\?(.*)$/);
  if (!drive) return null;
  const rest = (drive[2] ?? '').replace(/\\/g, '\\');
  const name = `${drive[1]}-${rest.replace(/\\/g, '~005C')}~0020`.replace(/~~005C/g, '~005C');
  return join(sessionsRoot, name);
}
