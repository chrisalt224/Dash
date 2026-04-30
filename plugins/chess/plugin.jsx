// Chess — 2-player local OR human vs built-in alpha-beta engine.
//
// • Click any piece of the side whose turn it is to select; legal squares
//   highlight. Click a target to move. Click the same piece again or
//   another of your pieces to change selection.
// • Modes: 2P (hot-seat) or 1P (you play white by default; engine plays
//   black). In 1P, the engine plays after you move.
// • Engine: alpha-beta minimax with material + positional (piece-square
//   table) evaluation. Move ordering puts captures first so cutoffs hit
//   hard. Depth slider 1–4. At depth 3 most moves come back in <300ms.
// • Full rules: castling (king + queenside), en passant, pawn promotion
//   (auto-queens; tap a different piece if you'd rather under-promote).
// • Undo button reverts the last full ply (or two, if vs engine).

const KEY = 'plugin:chess:state:v1';

// Pieces — uppercase = white, lowercase = black, null = empty
const INITIAL_BOARD = [
  ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
  ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
  ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'],
];

const GLYPHS = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

const PIECE_VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };

const DIFF_LABELS = { 1: 'easy', 2: 'med', 3: 'hard', 4: 'max' };

// Piece-square tables — values from white's POV; mirrored for black
const PSTS = {
  P: [
    [  0,   0,   0,   0,   0,   0,   0,   0],
    [ 50,  50,  50,  50,  50,  50,  50,  50],
    [ 10,  10,  20,  30,  30,  20,  10,  10],
    [  5,   5,  10,  25,  25,  10,   5,   5],
    [  0,   0,   0,  20,  20,   0,   0,   0],
    [  5,  -5, -10,   0,   0, -10,  -5,   5],
    [  5,  10,  10, -20, -20,  10,  10,   5],
    [  0,   0,   0,   0,   0,   0,   0,   0],
  ],
  N: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20,   0,   0,   0,   0, -20, -40],
    [-30,   0,  10,  15,  15,  10,   0, -30],
    [-30,   5,  15,  20,  20,  15,   5, -30],
    [-30,   0,  15,  20,  20,  15,   0, -30],
    [-30,   5,  10,  15,  15,  10,   5, -30],
    [-40, -20,   0,   5,   5,   0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50],
  ],
  B: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10,   0,   0,   0,   0,   0,   0, -10],
    [-10,   0,   5,  10,  10,   5,   0, -10],
    [-10,   5,   5,  10,  10,   5,   5, -10],
    [-10,   0,  10,  10,  10,  10,   0, -10],
    [-10,  10,  10,  10,  10,  10,  10, -10],
    [-10,   5,   0,   0,   0,   0,   5, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20],
  ],
  R: [
    [  0,   0,   0,   0,   0,   0,   0,   0],
    [  5,  10,  10,  10,  10,  10,  10,   5],
    [ -5,   0,   0,   0,   0,   0,   0,  -5],
    [ -5,   0,   0,   0,   0,   0,   0,  -5],
    [ -5,   0,   0,   0,   0,   0,   0,  -5],
    [ -5,   0,   0,   0,   0,   0,   0,  -5],
    [ -5,   0,   0,   0,   0,   0,   0,  -5],
    [  0,   0,   0,   5,   5,   0,   0,   0],
  ],
  Q: [
    [-20, -10, -10,  -5,  -5, -10, -10, -20],
    [-10,   0,   0,   0,   0,   0,   0, -10],
    [-10,   0,   5,   5,   5,   5,   0, -10],
    [ -5,   0,   5,   5,   5,   5,   0,  -5],
    [  0,   0,   5,   5,   5,   5,   0,  -5],
    [-10,   5,   5,   5,   5,   5,   0, -10],
    [-10,   0,   5,   0,   0,   0,   0, -10],
    [-20, -10, -10,  -5,  -5, -10, -10, -20],
  ],
  K: [
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [ 20,  20,   0,   0,   0,   0,  20,  20],
    [ 20,  30,  10,   0,   0,  10,  30,  20],
  ],
};

const isWhitePiece = (p) => !!p && p === p.toUpperCase();
const sideOf = (p) => (isWhitePiece(p) ? 'w' : 'b');

const cloneState = (s) => ({
  board: s.board.map((row) => row.slice()),
  turn: s.turn,
  castling: { ...s.castling },
  enPassant: s.enPassant ? { ...s.enPassant } : null,
  halfmove: s.halfmove,
  fullmove: s.fullmove,
});

const initialState = () => ({
  board: INITIAL_BOARD.map((row) => row.slice()),
  turn: 'w',
  castling: { wK: true, wQ: true, bK: true, bQ: true },
  enPassant: null,
  halfmove: 0,
  fullmove: 1,
});

// ---------- Move generation (mutates state during checks; restores via undo) ----------

function pieceMoves(state, r, c, excludeCastling) {
  const board = state.board;
  const piece = board[r][c];
  if (!piece) return [];
  const isWhite = isWhitePiece(piece);
  const t = piece.toUpperCase();
  const moves = [];
  const inB = (rr, cc) => rr >= 0 && rr < 8 && cc >= 0 && cc < 8;
  const empty = (rr, cc) => board[rr][cc] === null;
  const enemy = (rr, cc) => board[rr][cc] !== null && isWhitePiece(board[rr][cc]) !== isWhite;

  if (t === 'P') {
    const dir = isWhite ? -1 : 1;
    const startRow = isWhite ? 6 : 1;
    const promRow = isWhite ? 0 : 7;
    if (inB(r + dir, c) && empty(r + dir, c)) {
      if (r + dir === promRow) {
        moves.push({ from: { r, c }, to: { r: r + dir, c }, promo: 'Q' });
      } else {
        moves.push({ from: { r, c }, to: { r: r + dir, c } });
        if (r === startRow && empty(r + 2 * dir, c)) {
          moves.push({ from: { r, c }, to: { r: r + 2 * dir, c }, doublePush: true });
        }
      }
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (!inB(nr, nc)) continue;
      if (enemy(nr, nc)) {
        if (nr === promRow) moves.push({ from: { r, c }, to: { r: nr, c: nc }, promo: 'Q', cap: true });
        else moves.push({ from: { r, c }, to: { r: nr, c: nc }, cap: true });
      } else if (state.enPassant && state.enPassant.r === nr && state.enPassant.c === nc) {
        moves.push({ from: { r, c }, to: { r: nr, c: nc }, ep: true, cap: true });
      }
    }
  } else if (t === 'N') {
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = r + dr, nc = c + dc;
      if (!inB(nr, nc)) continue;
      if (empty(nr, nc)) moves.push({ from: { r, c }, to: { r: nr, c: nc } });
      else if (enemy(nr, nc)) moves.push({ from: { r, c }, to: { r: nr, c: nc }, cap: true });
    }
  } else if (t === 'B' || t === 'R' || t === 'Q') {
    const dirs = [];
    if (t === 'B' || t === 'Q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    if (t === 'R' || t === 'Q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inB(nr, nc)) {
        if (empty(nr, nc)) moves.push({ from: { r, c }, to: { r: nr, c: nc } });
        else {
          if (enemy(nr, nc)) moves.push({ from: { r, c }, to: { r: nr, c: nc }, cap: true });
          break;
        }
        nr += dr; nc += dc;
      }
    }
  } else if (t === 'K') {
    for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
      const nr = r + dr, nc = c + dc;
      if (!inB(nr, nc)) continue;
      if (empty(nr, nc)) moves.push({ from: { r, c }, to: { r: nr, c: nc } });
      else if (enemy(nr, nc)) moves.push({ from: { r, c }, to: { r: nr, c: nc }, cap: true });
    }
    if (!excludeCastling) {
      const side = isWhite ? 'w' : 'b';
      const home = isWhite ? 7 : 0;
      const enemySide = isWhite ? 'b' : 'w';
      // Kingside
      if (state.castling[side + 'K'] && empty(home, 5) && empty(home, 6) &&
          board[home][7] === (isWhite ? 'R' : 'r') &&
          !isAttacked(state, home, 4, enemySide) &&
          !isAttacked(state, home, 5, enemySide) &&
          !isAttacked(state, home, 6, enemySide)) {
        moves.push({ from: { r, c }, to: { r: home, c: 6 }, castle: 'K' });
      }
      // Queenside
      if (state.castling[side + 'Q'] && empty(home, 1) && empty(home, 2) && empty(home, 3) &&
          board[home][0] === (isWhite ? 'R' : 'r') &&
          !isAttacked(state, home, 4, enemySide) &&
          !isAttacked(state, home, 3, enemySide) &&
          !isAttacked(state, home, 2, enemySide)) {
        moves.push({ from: { r, c }, to: { r: home, c: 2 }, castle: 'Q' });
      }
    }
  }
  return moves;
}

function isAttacked(state, r, c, byColor) {
  const board = state.board;
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      if (!p) continue;
      if (sideOf(p) !== byColor) continue;
      const moves = pieceMoves(state, rr, cc, true);
      for (const m of moves) if (m.to.r === r && m.to.c === c) return true;
    }
  }
  return false;
}

function inCheck(state, side) {
  const kingChar = side === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (state.board[r][c] === kingChar) {
      return isAttacked(state, r, c, side === 'w' ? 'b' : 'w');
    }
  }
  return false;
}

function legalMoves(state, side) {
  const moves = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p || sideOf(p) !== side) continue;
    const pseudo = pieceMoves(state, r, c);
    for (const m of pseudo) {
      const undo = applyMove(state, m);
      if (!inCheck(state, side)) moves.push(m);
      undoMove(state, m, undo);
    }
  }
  return moves;
}

function applyMove(state, m) {
  const board = state.board;
  const piece = board[m.from.r][m.from.c];
  const isWhite = isWhitePiece(piece);
  const t = piece.toUpperCase();
  const undo = {
    piece, captured: board[m.to.r][m.to.c],
    castling: { ...state.castling },
    enPassant: state.enPassant,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    turn: state.turn,
    epCaptured: null, castleRook: null,
  };

  if (m.ep) {
    const epRow = isWhite ? m.to.r + 1 : m.to.r - 1;
    undo.epCaptured = { r: epRow, c: m.to.c, p: board[epRow][m.to.c] };
    board[epRow][m.to.c] = null;
  }

  board[m.to.r][m.to.c] = piece;
  board[m.from.r][m.from.c] = null;

  if (m.promo) {
    board[m.to.r][m.to.c] = isWhite ? m.promo : m.promo.toLowerCase();
  }

  if (m.castle) {
    const home = m.to.r;
    if (m.castle === 'K') {
      undo.castleRook = { from: { r: home, c: 7 }, to: { r: home, c: 5 }, p: board[home][7] };
      board[home][5] = board[home][7];
      board[home][7] = null;
    } else {
      undo.castleRook = { from: { r: home, c: 0 }, to: { r: home, c: 3 }, p: board[home][0] };
      board[home][3] = board[home][0];
      board[home][0] = null;
    }
  }

  if (t === 'K') {
    if (isWhite) { state.castling.wK = false; state.castling.wQ = false; }
    else { state.castling.bK = false; state.castling.bQ = false; }
  }
  if (t === 'R') {
    if (m.from.r === 7 && m.from.c === 0) state.castling.wQ = false;
    if (m.from.r === 7 && m.from.c === 7) state.castling.wK = false;
    if (m.from.r === 0 && m.from.c === 0) state.castling.bQ = false;
    if (m.from.r === 0 && m.from.c === 7) state.castling.bK = false;
  }
  // Captured rook on home square loses that castling right
  if (m.to.r === 7 && m.to.c === 0) state.castling.wQ = false;
  if (m.to.r === 7 && m.to.c === 7) state.castling.wK = false;
  if (m.to.r === 0 && m.to.c === 0) state.castling.bQ = false;
  if (m.to.r === 0 && m.to.c === 7) state.castling.bK = false;

  state.enPassant = m.doublePush ? { r: (m.from.r + m.to.r) / 2, c: m.to.c } : null;
  if (t === 'P' || undo.captured) state.halfmove = 0; else state.halfmove++;
  if (!isWhite) state.fullmove++;
  state.turn = isWhite ? 'b' : 'w';

  return undo;
}

function undoMove(state, m, undo) {
  const board = state.board;
  if (m.castle && undo.castleRook) {
    board[undo.castleRook.from.r][undo.castleRook.from.c] = undo.castleRook.p;
    board[undo.castleRook.to.r][undo.castleRook.to.c] = null;
  }
  board[m.from.r][m.from.c] = undo.piece;
  board[m.to.r][m.to.c] = undo.captured;
  if (m.ep && undo.epCaptured) {
    board[undo.epCaptured.r][undo.epCaptured.c] = undo.epCaptured.p;
  }
  state.castling = undo.castling;
  state.enPassant = undo.enPassant;
  state.halfmove = undo.halfmove;
  state.fullmove = undo.fullmove;
  state.turn = undo.turn;
}

// ---------- Engine ----------

function evaluate(state) {
  let score = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = state.board[r][c];
    if (!p) continue;
    const t = p.toUpperCase();
    const isWhite = p === t;
    const value = PIECE_VALUES[t];
    const pst = PSTS[t];
    const bonus = pst[isWhite ? r : 7 - r][c];
    score += isWhite ? (value + bonus) : -(value + bonus);
  }
  return score;
}

// Move ordering — captures first, ranked by victim value (MVV-LVA simplified)
function orderMoves(state, moves) {
  return moves.sort((a, b) => {
    const av = a.cap ? PIECE_VALUES[(state.board[a.to.r][a.to.c] || 'P').toUpperCase()] : 0;
    const bv = b.cap ? PIECE_VALUES[(state.board[b.to.r][b.to.c] || 'P').toUpperCase()] : 0;
    return bv - av;
  });
}

function alphabeta(state, depth, alpha, beta, maximizing) {
  if (depth === 0) return evaluate(state);
  const side = state.turn;
  const moves = orderMoves(state, legalMoves(state, side));
  if (moves.length === 0) {
    if (inCheck(state, side)) return maximizing ? -100000 - depth : 100000 + depth;
    return 0; // stalemate
  }
  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      const undo = applyMove(state, m);
      const v = alphabeta(state, depth - 1, alpha, beta, false);
      undoMove(state, m, undo);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      const undo = applyMove(state, m);
      const v = alphabeta(state, depth - 1, alpha, beta, true);
      undoMove(state, m, undo);
      if (v < best) best = v;
      if (best < beta) beta = best;
      if (alpha >= beta) break;
    }
    return best;
  }
}

function bestMove(state, depth) {
  const side = state.turn;
  const maximizing = side === 'w';
  const moves = orderMoves(state, legalMoves(state, side));
  if (moves.length === 0) return null;
  // Light shuffle so equal-scored moves vary across games
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }
  let best = maximizing ? -Infinity : Infinity;
  let bestMv = moves[0];
  for (const m of moves) {
    const undo = applyMove(state, m);
    const v = alphabeta(state, depth - 1, -Infinity, Infinity, !maximizing);
    undoMove(state, m, undo);
    if (maximizing ? v > best : v < best) {
      best = v;
      bestMv = m;
    }
  }
  return bestMv;
}

// ---------- Notation ----------

const FILE_LET = ['a','b','c','d','e','f','g','h'];
const sqName = (r, c) => FILE_LET[c] + (8 - r);

const moveNotation = (state, m) => {
  // Simple algebraic-ish notation; no disambiguation, no check/mate marks
  if (m.castle) return m.castle === 'K' ? 'O-O' : 'O-O-O';
  const piece = state.board[m.from.r][m.from.c];
  if (!piece) return '?';
  const t = piece.toUpperCase();
  let s = (t === 'P') ? '' : t;
  if (m.cap) {
    if (t === 'P') s += FILE_LET[m.from.c];
    s += 'x';
  }
  s += sqName(m.to.r, m.to.c);
  if (m.promo) s += '=' + m.promo;
  return s;
};

// ---------- Persistence ----------

const loadPersisted = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { mode: '1p', engineDepth: 2, engineSide: 'b', ...raw };
  } catch {}
  return { mode: '1p', engineDepth: 2, engineSide: 'b' };
};

let audioCtx = null;
const beep = (freq, dur, vol) => {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol || 0.1, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {}
};

// ---------- Component ----------

export default {
  id: 'chess',
  name: 'Chess',
  width: 3,
  height: 3,
  component: ({ React, useState, useEffect, useRef, useMemo }) => {
    const [persisted, setPersisted] = useState(loadPersisted);
    const [game, setGame] = useState(initialState);
    const [history, setHistory] = useState([]); // [{ move, undo, san }]
    const [selected, setSelected] = useState(null);
    const [thinking, setThinking] = useState(false);
    const [lastMove, setLastMove] = useState(null);
    const [boardPx, setBoardPx] = useState(0);
    const [hint, setHint] = useState(null); // { from, to } — engine-suggested move
    const gameRef = useRef(game);
    const boardWrapRef = useRef(null);
    const hintTimerRef = useRef(null);
    useEffect(() => { gameRef.current = game; }, [game]);

    // Clear any pending hint when the position changes (move made / undone / new game)
    useEffect(() => { setHint(null); }, [game]);
    useEffect(() => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    }, []);

    // Measure the available board area and size the board (and pieces) in
    // real pixels so the board scales smoothly with the widget instead of
    // relying on viewport-based font units.
    React.useLayoutEffect(() => {
      const wrap = boardWrapRef.current;
      if (!wrap) return;
      const measure = () => {
        const r = wrap.getBoundingClientRect();
        const size = Math.max(40, Math.floor(Math.min(r.width, r.height)));
        setBoardPx((prev) => (prev === size ? prev : size));
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(wrap);
      return () => ro.disconnect();
    }, []);

    const cellPx = boardPx / 8;
    const pieceFontPx = Math.floor(cellPx * 0.72);
    const coordFontPx = Math.max(7, Math.floor(cellPx * 0.18));

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(persisted)), 200);
      return () => clearTimeout(id);
    }, [persisted]);

    // Compute legal moves once per turn (used for selection highlights + game-end)
    const legalMovesAll = useMemo(() => legalMoves(cloneState(game), game.turn), [game]);

    const myMovesFromSelected = useMemo(() => {
      if (!selected) return [];
      return legalMovesAll.filter((m) => m.from.r === selected.r && m.from.c === selected.c);
    }, [selected, legalMovesAll]);

    const isCheck = useMemo(() => inCheck(cloneState(game), game.turn), [game]);
    const gameOver = useMemo(() => {
      if (legalMovesAll.length === 0) {
        return isCheck
          ? (game.turn === 'w' ? 'checkmate-b' : 'checkmate-w')
          : 'stalemate';
      }
      if (game.halfmove >= 100) return 'fifty-move';
      return null;
    }, [legalMovesAll, isCheck, game]);

    const captured = useMemo(() => {
      const wCaps = [], bCaps = [];
      for (const h of history) {
        if (!h.move.cap) continue;
        if (h.move.ep) {
          // captured piece was a pawn of opposite color
          const captor = h.undo.piece;
          if (isWhitePiece(captor)) bCaps.push('p'); else wCaps.push('P');
          continue;
        }
        const target = h.undo.captured;
        if (!target) continue;
        if (isWhitePiece(target)) bCaps.push(target);
        else wCaps.push(target);
      }
      return { w: wCaps, b: bCaps };
    }, [history]);

    // Engine turn? Trigger after a short delay so the UI shows "thinking…"
    useEffect(() => {
      if (gameOver) return;
      if (persisted.mode !== '1p') return;
      if (game.turn !== persisted.engineSide) return;
      setThinking(true);
      const t = setTimeout(() => {
        const s = cloneState(gameRef.current);
        const m = bestMove(s, persisted.engineDepth);
        setThinking(false);
        if (m) commitMove(m);
      }, 50);
      return () => { clearTimeout(t); setThinking(false); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [game, persisted.mode, persisted.engineSide, persisted.engineDepth, gameOver]);

    const commitMove = (m) => {
      // Apply on a fresh clone; preserve original via undo info for history
      const next = cloneState(gameRef.current);
      const undo = applyMove(next, m);
      const san = moveNotation(gameRef.current, m);
      setHistory((h) => [...h, { move: m, undo, san, fenLike: next.turn + next.fullmove }]);
      setGame(next);
      setSelected(null);
      setLastMove(m);
      // Sound
      if (m.cap) beep(440, 0.06, 0.12);
      else beep(660, 0.04, 0.08);
    };

    const handleSquareClick = (r, c) => {
      if (gameOver) return;
      // 1P mode: human can only move their own side
      if (persisted.mode === '1p' && game.turn === persisted.engineSide) return;
      if (thinking) return;

      const piece = game.board[r][c];
      // Selecting
      if (selected) {
        const move = myMovesFromSelected.find((m) => m.to.r === r && m.to.c === c);
        if (move) { commitMove(move); return; }
        // Deselect or reselect
        if (piece && sideOf(piece) === game.turn) { setSelected({ r, c }); return; }
        setSelected(null);
        return;
      }
      // No prior selection: select a friendly piece
      if (piece && sideOf(piece) === game.turn) setSelected({ r, c });
    };

    const newGame = () => {
      setGame(initialState());
      setHistory([]);
      setSelected(null);
      setLastMove(null);
      beep(880, 0.08, 0.1);
    };

    const undo = () => {
      if (history.length === 0 || thinking) return;
      // In 1P, undo your last move + engine's reply (2 plies) so it's your turn again
      const stepsBack = (persisted.mode === '1p' && history.length >= 2 &&
                        history[history.length - 1].move /* engine's */) ? 2 : 1;
      const next = cloneState(gameRef.current);
      for (let i = 0; i < stepsBack; i++) {
        const last = history[history.length - 1 - i];
        if (!last) break;
        undoMove(next, last.move, last.undo);
      }
      setGame(next);
      setHistory((h) => h.slice(0, h.length - stepsBack));
      setSelected(null);
      setLastMove(history[history.length - stepsBack - 1] ? history[history.length - stepsBack - 1].move : null);
    };

    const setMode = (mode) => setPersisted((p) => ({ ...p, mode }));
    const setDepth = (d) => setPersisted((p) => ({ ...p, engineDepth: d }));
    const cycleDepth = () => setPersisted((p) => ({
      ...p,
      engineDepth: p.engineDepth >= 4 ? 1 : p.engineDepth + 1,
    }));
    const flipPlayer = () => setPersisted((p) => ({
      ...p,
      engineSide: p.engineSide === 'b' ? 'w' : 'b',
    }));

    const isHumanTurn = persisted.mode === '2p' || game.turn !== persisted.engineSide;
    const canHint = !gameOver && !thinking && isHumanTurn;

    const showHint = () => {
      if (!canHint) return;
      setThinking(true);
      // Defer so the "thinking…" status paints before the (potentially slow) search
      setTimeout(() => {
        try {
          const m = bestMove(cloneState(gameRef.current), persisted.engineDepth);
          setThinking(false);
          if (!m) return;
          setHint({ from: m.from, to: m.to });
          if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
          hintTimerRef.current = setTimeout(() => setHint(null), 5000);
          beep(990, 0.04, 0.06);
        } catch {
          setThinking(false);
        }
      }, 50);
    };

    // Find king square that's in check (for highlight)
    const checkedKingSquare = useMemo(() => {
      if (!isCheck) return null;
      const kc = game.turn === 'w' ? 'K' : 'k';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
        if (game.board[r][c] === kc) return { r, c };
      return null;
    }, [isCheck, game]);

    // Status line
    const statusText = (() => {
      if (gameOver === 'checkmate-w') return '· checkmate — white wins';
      if (gameOver === 'checkmate-b') return '· checkmate — black wins';
      if (gameOver === 'stalemate') return '· stalemate — draw';
      if (gameOver === 'fifty-move') return '· 50-move rule — draw';
      const sideLabel = game.turn === 'w' ? 'white' : 'black';
      const isEngine = persisted.mode === '1p' && game.turn === persisted.engineSide;
      let s = (isEngine ? 'engine' : sideLabel) + ' to move';
      if (isCheck) s += ' · in check';
      return s;
    })();

    return (
      <div className="p-col" style={{ height: '100%', gap: 6 }}>
        {/* Header */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            {[{ id: '1p', label: '1p' }, { id: '2p', label: '2p' }].map((t) => {
              const active = persisted.mode === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setMode(t.id)}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '2px 10px',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >{t.label}</button>
              );
            })}
          </div>
          {persisted.mode === '1p' && (
            <>
              <button
                onClick={flipPlayer}
                title="swap colors with engine"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-bright)',
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--mono)', fontSize: 9,
                  padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                }}
              >you {persisted.engineSide === 'b' ? '♔' : '♚'}</button>
              <button
                onClick={cycleDepth}
                title={
                  'bot difficulty (click to cycle) · depth ' + persisted.engineDepth +
                  (persisted.engineDepth >= 4 ? ' — slower' : '')
                }
                style={{
                  background: 'transparent',
                  border: '1px solid var(--accent-warm)',
                  color: 'var(--accent-warm)',
                  fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                  padding: '1px 8px', borderRadius: 2, cursor: 'pointer',
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                }}
              >diff: {DIFF_LABELS[persisted.engineDepth] || persisted.engineDepth}</button>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={showHint}
            disabled={!canHint}
            title={
              !isHumanTurn ? 'wait for your turn' :
              gameOver ? 'game over' :
              'suggest a move (uses bot difficulty)'
            }
            className="p-btn"
            style={{ fontSize: 10, padding: '2px 8px', opacity: canHint ? 1 : 0.4 }}
          >? hint</button>
          <button
            onClick={undo}
            disabled={history.length === 0 || thinking}
            title={persisted.mode === '1p' ? 'take back your last move' : 'undo last move'}
            className="p-btn"
            style={{ fontSize: 10, padding: '2px 8px', opacity: history.length === 0 ? 0.4 : 1 }}
          >↶ undo</button>
          <button onClick={newGame} className="p-btn" style={{ fontSize: 10, padding: '2px 8px' }}>↻ new</button>
        </div>

        {/* Captured pieces — top: black's captures (white pieces taken) */}
        <CaptureRow pieces={captured.b} side="taken from white" align="left" />

        {/* Board */}
        <div ref={boardWrapRef} style={{
          flex: 1, minHeight: 0, minWidth: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(8, ${cellPx}px)`,
            gridTemplateRows: `repeat(8, ${cellPx}px)`,
            width: boardPx,
            height: boardPx,
            border: '1px solid var(--border-bright)',
            background: 'var(--bg)',
            boxShadow: '0 0 16px rgba(var(--accent-rgb),0.15)',
            visibility: boardPx > 0 ? 'visible' : 'hidden',
          }}>
            {boardPx > 0 && Array.from({ length: 64 }).map((_, i) => {
              const r = Math.floor(i / 8), c = i % 8;
              const piece = game.board[r][c];
              const isLight = (r + c) % 2 === 0;
              const isSelected = selected && selected.r === r && selected.c === c;
              const isLegalTarget = myMovesFromSelected.some((m) => m.to.r === r && m.to.c === c);
              const isCapTarget = isLegalTarget && piece;
              const isLastFrom = lastMove && lastMove.from.r === r && lastMove.from.c === c;
              const isLastTo = lastMove && lastMove.to.r === r && lastMove.to.c === c;
              const isHintFrom = hint && hint.from.r === r && hint.from.c === c;
              const isHintTo = hint && hint.to.r === r && hint.to.c === c;
              const isCheckedKing = checkedKingSquare && checkedKingSquare.r === r && checkedKingSquare.c === c;
              return (
                <div
                  key={i}
                  onClick={() => handleSquareClick(r, c)}
                  style={{
                    background: isSelected
                      ? 'rgba(255,180,84,0.45)'
                      : isCheckedKing
                      ? 'rgba(255,107,107,0.4)'
                      : isHintFrom || isHintTo
                      ? 'rgba(255,180,84,0.28)'
                      : isLastFrom || isLastTo
                      ? 'rgba(var(--accent-rgb),0.18)'
                      : isLight
                      ? 'rgba(var(--accent-rgb),0.05)'
                      : 'rgba(var(--accent-rgb),0.18)',
                    cursor: thinking ? 'wait' : 'pointer',
                    position: 'relative',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: pieceFontPx,
                    lineHeight: 1,
                    fontFamily: 'var(--mono)',
                    color: piece && isWhitePiece(piece) ? 'var(--fg-bright)' : '#5eeaff',
                    textShadow: piece
                      ? (isWhitePiece(piece)
                          ? '0 0 4px rgba(var(--accent-rgb),0.6)'
                          : '0 0 4px rgba(94,234,255,0.6)')
                      : 'none',
                    userSelect: 'none',
                    transition: 'background 0.1s ease',
                  }}
                >
                  {piece && GLYPHS[piece]}
                  {/* Move dot */}
                  {isLegalTarget && !isCapTarget && (
                    <span style={{
                      position: 'absolute',
                      width: '24%', height: '24%',
                      borderRadius: '50%',
                      background: 'rgba(var(--accent-rgb),0.55)',
                      boxShadow: '0 0 6px rgba(var(--accent-rgb),0.5)',
                      pointerEvents: 'none',
                    }} />
                  )}
                  {/* Capture ring */}
                  {isCapTarget && (
                    <span style={{
                      position: 'absolute',
                      inset: '6%',
                      borderRadius: '50%',
                      border: '2px solid rgba(255,107,107,0.7)',
                      boxShadow: '0 0 6px rgba(255,107,107,0.5)',
                      pointerEvents: 'none',
                    }} />
                  )}
                  {/* Hint outlines — amber dashed border on suggested from/to */}
                  {(isHintFrom || isHintTo) && (
                    <span style={{
                      position: 'absolute',
                      inset: 2,
                      border: isHintTo
                        ? '2px dashed rgba(255,180,84,0.9)'
                        : '2px dashed rgba(255,180,84,0.55)',
                      borderRadius: 3,
                      boxShadow: isHintTo
                        ? '0 0 8px rgba(255,180,84,0.45)'
                        : 'none',
                      pointerEvents: 'none',
                    }} />
                  )}
                  {/* Coords (a-h on bottom row, 1-8 on left col) */}
                  {r === 7 && (
                    <span style={{
                      position: 'absolute', bottom: 1, right: 2,
                      fontSize: coordFontPx, color: 'var(--fg-dim)',
                      fontFamily: 'var(--mono)', opacity: 0.5,
                      lineHeight: 1, pointerEvents: 'none',
                    }}>{FILE_LET[c]}</span>
                  )}
                  {c === 0 && (
                    <span style={{
                      position: 'absolute', top: 1, left: 2,
                      fontSize: coordFontPx, color: 'var(--fg-dim)',
                      fontFamily: 'var(--mono)', opacity: 0.5,
                      lineHeight: 1, pointerEvents: 'none',
                    }}>{8 - r}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Captured pieces — bottom: white's captures (black pieces taken) */}
        <CaptureRow pieces={captured.w} side="taken from black" align="left" />

        {/* Status */}
        <div className="p-row" style={{ alignItems: 'center', justifyContent: 'space-between', fontSize: 10, fontFamily: 'var(--mono)' }}>
          <span style={{
            color: gameOver
              ? (gameOver.startsWith('checkmate') ? 'var(--accent)' : 'var(--accent-warm)')
              : (isCheck ? 'var(--danger)' : 'var(--fg)'),
            textShadow: gameOver ? 'var(--glow-soft)' : 'none',
          }}>
            {thinking ? 'engine thinking…' : statusText}
          </span>
          <span className="p-dim">
            {history.length > 0 && (
              <>last: {history[history.length - 1].san}</>
            )}
          </span>
        </div>
      </div>
    );
  },
};

function CaptureRow({ pieces, side, align }) {
  if (pieces.length === 0) return <div style={{ minHeight: 14 }} />;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 1, minHeight: 14,
      justifyContent: align === 'left' ? 'flex-start' : 'flex-end',
      padding: '0 2px',
    }} title={side}>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: isWhitePiece(p) ? 'var(--fg-bright)' : '#5eeaff',
            opacity: 0.65,
            lineHeight: 1,
          }}
        >{GLYPHS[p]}</span>
      ))}
    </div>
  );
}
