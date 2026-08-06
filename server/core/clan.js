/* PaperTrench server — clans.
 *
 * A clan is NOT a book. It is a question asked of records that already exist:
 * "how do these people's committed chains look, over this window, counted only
 * from the moment each of them joined?" Every number a clan shows is somebody's
 * window entry (window.js) — the same slice the Sprint and duels use — so there
 * is no clan-side ledger to inflate and nothing new to trust.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT MAKE THIS UNCHEATABLE
 *
 * 1. YOU BRING YOUR FUTURE, NOT YOUR PAST.
 *
 *    A member's contribution window starts at their join time. Rounds closed
 *    before they joined count for nothing here. Without this, the dominant
 *    strategy is obvious and fatal: recruit a strong trader for one day and
 *    their entire lifetime record lands on your board, then repeat before every
 *    weekly close. With it, a round counts for at most one clan — the one you
 *    were actually in when you closed it — and joining a clan the night before
 *    the bell contributes exactly nothing.
 *
 * 2. THE SCORE IS THE MEAN OF THE TOP FIVE, AND A CLAN NEEDS FIVE TO RANK.
 *
 *    Summing member scores makes this a recruiting contest: the biggest roster
 *    wins regardless of skill. Averaging the WHOLE roster is worse in a way
 *    that matters more — it charges a clan for every beginner it takes in, and
 *    a product that exists to give newcomers somewhere to practice must not
 *    make teaching them expensive. The mean of the top five does neither.
 *    Extra members are free, so recruit and teach all you like; one hero cannot
 *    carry a clan, because five people have to clear the bar.
 *
 *    It has a third property worth stating out loud, because it is the reason
 *    to prefer it over anything cleverer: CUTTING A STRUGGLING MEMBER CAN NEVER
 *    RAISE A CLAN'S SCORE. The top five is the top five whether or not the
 *    people below it are on the roster; expelling them can only cost the clan
 *    its roster minimum. There is no version of this board where kicking the
 *    worst trader is the winning move.
 *
 * The honest cost, stated rather than hidden: depth is a mild advantage. A
 * clan with thirty qualified members has more chances at five strong ones than
 * a clan with exactly five. That advantage has to be earned five verified
 * records at a time, which is the point.
 * ---------------------------------------------------------------------------
 */
'use strict';

const { windowEntry } = require('./window.js');
const { MIN_RANKED_ROUNDS } = require('./ranking.js');

/** How many member scores make a clan's number. */
const COUNTING_MEMBERS = 5;

/**
 * Roster cap.
 *
 * Not an anti-cheat measure — the top-five mean already makes hoarding
 * pointless — but a roster page has to stay readable, and the depth advantage
 * above should not grow without bound.
 */
const MAX_MEMBERS = 50;

/** Rounds a member needs inside the window before they can be one of the five.
 * The season floor is the individual board's floor: five closed rounds is a
 * record, four is a sample. A week is short, so a single closed round counts
 * there — the same bar the individual Sprint board uses. */
const MIN_SEASON_ROUNDS = MIN_RANKED_ROUNDS;
const MIN_WEEK_ROUNDS = 1;

/** The largest timestamp a Date can hold — the season's open right edge. */
const SEASON_END_TS = 8640000000000000;
const SEASON_WINDOW = { startTs: 0, endTs: SEASON_END_TS };

/* ------------------------------------------------------------- identity -- */
/*
 * Clan names and tags are the only user-authored strings this product renders
 * next to verified numbers, so they are validated like input rather than
 * accepted like content: a narrow ASCII charset (no homoglyph or zero-width
 * impersonation of another clan), a normalised uniqueness key so "Trench Rats"
 * and "trenchrats" cannot both exist, and a short reserved list so nobody can
 * imply they speak for PaperTrench.
 */

const TAG_RE = /^[A-Z0-9]{2,5}$/;
const RESERVED_TAGS = new Set([
  'ADMIN', 'MOD', 'MODS', 'STAFF', 'TEAM', 'OWNER', 'PT', 'ARENA', 'NULL', 'NONE',
]);

const NAME_MIN = 3;
const NAME_MAX = 24;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'&!-]*[A-Za-z0-9.!]$/;
const RESERVED_NAME_KEYS = ['papertrench'];

const MOTTO_MAX = 120;
const MOTTO_RE = /^[A-Za-z0-9 .,!?'"&:;()\/-]*$/;

/**
 * Collapse every run of whitespace to one plain space, then trim.
 *
 * `\s` catches the invisible ones — U+00A0, U+2009 and friends — which is the
 * point: normalising them means two clans cannot differ only by a character
 * nobody can see, and it fixes a paste rather than rejecting it.
 */
function squash(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

const normalizeTag = (raw) => squash(raw).toUpperCase();
const normalizeName = (raw) => squash(raw);
const normalizeCode = (raw) => squash(raw).toUpperCase();
const cleanMotto = (raw) => squash(raw);

/** The uniqueness key for a name: lowercase, alphanumerics only. */
const nameKey = (raw) => normalizeName(raw).toLowerCase().replace(/[^a-z0-9]/g, '');

function tagProblem(raw) {
  const tag = normalizeTag(raw);
  if (!TAG_RE.test(tag)) return 'tag-shape';
  if (RESERVED_TAGS.has(tag)) return 'tag-reserved';
  return null;
}

function nameProblem(raw) {
  const name = normalizeName(raw);
  if (name.length < NAME_MIN) return 'name-too-short';
  if (name.length > NAME_MAX) return 'name-too-long';
  if (!NAME_RE.test(name)) return 'name-charset';
  const key = nameKey(name);
  // A name that is almost entirely punctuation has a uniqueness key too short
  // to distinguish it from anything else, so it is refused for the same reason
  // a two-letter name is.
  if (key.length < NAME_MIN) return 'name-too-short';
  if (RESERVED_NAME_KEYS.some((reserved) => key.includes(reserved))) return 'name-reserved';
  return null;
}

function mottoProblem(raw) {
  const motto = cleanMotto(raw);
  if (motto.length > MOTTO_MAX) return 'motto-too-long';
  if (!MOTTO_RE.test(motto)) return 'motto-charset';
  return null;
}

/* -------------------------------------------------------- contribution --- */

/**
 * The slice of a mode window a member's fills may count toward this clan.
 *
 * Rule 1 above, made concrete: the window's own start, or the moment they
 * joined, whichever is later. Everything downstream is `windowEntry` over this
 * — no new math, which is exactly why there is no new way to cheat.
 */
function contributionWindow(joinedAt, window) {
  const joined = Math.trunc(Number(joinedAt) || 0);
  return {
    startTs: Math.max(Math.trunc(Number(window && window.startTs) || 0), joined),
    endTs: Math.trunc(Number(window && window.endTs) || 0),
  };
}

/**
 * One member's contribution to one clan window, from their full chain.
 *
 * Returns null when the slice is empty — someone who joined after a window
 * closed contributed nothing to it, and null says that. A zeroed entry would
 * claim they showed up and did nothing, which is a different fact.
 */
function memberEntry(links, startingSol, joinedAt, window) {
  const slice = contributionWindow(joinedAt, window);
  if (!(slice.endTs > slice.startTs)) return null;
  return Object.assign(
    { startTs: slice.startTs, endTs: slice.endTs },
    windowEntry(links, startingSol, slice)
  );
}

/* ------------------------------------------------------------ standing --- */

/**
 * A clan's standing for one window, from its members' contribution entries.
 *
 * `members` is [{ handle, userId, status, joinedAt, entry }] where `entry` is
 * `memberEntry` output (or null). `status` is the verification tier of that
 * member's own record — a rejected record ranks nowhere, and it does not get
 * to rank by hiding inside a clan either.
 *
 * An unranked clan gets `score: null`, never a zero. Zero is a result; not
 * having fielded five qualified members yet is an absence, and this product
 * does not print one as the other.
 */
function standing(members, options) {
  const opts = options || {};
  const minRounds = Number.isFinite(Number(opts.minRounds))
    ? Number(opts.minRounds) : MIN_SEASON_ROUNDS;
  const roster = Array.isArray(members) ? members : [];

  const eligible = roster.filter((m) => m && m.entry && m.status !== 'rejected');
  const active = eligible.filter((m) => Number(m.entry.rounds) > 0);
  const qualified = eligible
    .filter((m) => (Number(m.entry.rounds) || 0) >= minRounds)
    .sort((a, b) => (Number(b.entry.score) || 0) - (Number(a.entry.score) || 0));

  const counting = qualified.slice(0, COUNTING_MEMBERS);
  const ranked = counting.length >= COUNTING_MEMBERS;
  const total = counting.reduce((sum, m) => sum + (Number(m.entry.score) || 0), 0);

  return {
    roster: roster.length,
    active: active.length,
    qualified: qualified.length,
    needed: Math.max(0, COUNTING_MEMBERS - qualified.length),
    ranked,
    score: ranked ? total / COUNTING_MEMBERS : null,
    // Who currently makes the number, best first. Shown on the clan page so a
    // clan's score is never a figure nobody can attribute.
    counting: counting.map((m) => ({
      handle: m.handle,
      status: m.status || 'pending',
      joinedAt: Number(m.joinedAt) || 0,
      score: Number(m.entry.score) || 0,
      roiPct: Number(m.entry.roiPct) || 0,
      rounds: Number(m.entry.rounds) || 0,
    })),
    // Volume figures span everyone who traded in the window, not just the five.
    // They describe the clan's activity; they never feed the score.
    rounds: active.reduce((sum, m) => sum + (Number(m.entry.rounds) || 0), 0),
    pnlSol: active.reduce((sum, m) => sum + (Number(m.entry.pnlSol) || 0), 0),
  };
}

/* ---------------------------------------------------------- membership --- */

/** Why a create attempt is refused, or null when it may proceed. */
function createProblem(input) {
  const form = input || {};
  if (form.alreadyInClan) return 'already-in-a-clan';
  return tagProblem(form.tag) || nameProblem(form.name) || mottoProblem(form.motto);
}

/**
 * Why a join attempt is refused, or null.
 *
 * An invite-only clan needs the code; an open clan needs nothing but an
 * account. A clan with no code stored can never be joined by code — the empty
 * string must not match the empty string.
 */
function joinProblem(clan, memberCount, options) {
  const opts = options || {};
  if (opts.alreadyInClan) return 'already-in-a-clan';
  if (!clan) return 'not-found';
  if ((Number(memberCount) || 0) >= MAX_MEMBERS) return 'clan-full';
  if (!clan.open) {
    const want = normalizeCode(clan.joinCode);
    if (!want || normalizeCode(opts.code) !== want) return 'bad-code';
  }
  return null;
}

/** Why a kick is refused, or null. Founders only, and never themselves. */
function kickProblem(clan, actorId, targetId) {
  if (!clan) return 'not-found';
  if (Number(clan.founderId) !== Number(actorId)) return 'not-founder';
  if (Number(targetId) === Number(clan.founderId)) return 'cannot-kick-founder';
  return null;
}

/**
 * Who inherits a clan when its founder leaves: the earliest-joined member
 * still standing, ties broken by user id so the answer is deterministic.
 * Null means the clan is now empty and should be disbanded rather than left
 * as an ownerless shell.
 */
function successor(members, leavingUserId) {
  const rest = (Array.isArray(members) ? members : [])
    .filter((m) => Number(m.userId) !== Number(leavingUserId));
  if (!rest.length) return null;
  return rest.slice().sort((a, b) =>
    (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0) ||
    (Number(a.userId) || 0) - (Number(b.userId) || 0))[0];
}

module.exports = {
  COUNTING_MEMBERS, MAX_MEMBERS, MIN_SEASON_ROUNDS, MIN_WEEK_ROUNDS,
  SEASON_END_TS, SEASON_WINDOW,
  TAG_RE, NAME_MIN, NAME_MAX, MOTTO_MAX, RESERVED_TAGS,
  normalizeTag, normalizeName, normalizeCode, cleanMotto, nameKey,
  tagProblem, nameProblem, mottoProblem,
  contributionWindow, memberEntry, standing,
  createProblem, joinProblem, kickProblem, successor,
};
