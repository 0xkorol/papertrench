/* PaperTrench server — chain contract, re-exported.
 *
 * The server verifies the SAME bytes the extension commits. Importing the
 * extension's attest.js (storage-agnostic by design) instead of copying it
 * means the preimage format cannot drift between the two halves: a change to
 * the contract breaks one shared test suite, not a silent fork.
 */
'use strict';

const AT = require('../../extension/attest.js');

module.exports = {
  VERSION: AT.VERSION,
  GENESIS: AT.GENESIS,
  sha256: AT.sha256,
  fillPreimage: AT.fillPreimage,
  appendFill: AT.appendFill,
  verifyChain: AT.verifyChain,
  replayChain: AT.replayChain,
  claimMatchesChain: AT.claimMatchesChain,
};
