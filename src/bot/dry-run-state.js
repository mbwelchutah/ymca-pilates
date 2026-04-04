let dryRunEnabled = false;

module.exports = {
  getDryRun: () => dryRunEnabled,
  setDryRun: (val) => { dryRunEnabled = !!val; },
};
