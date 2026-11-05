'use strict';

const rows = require('./InstallerMessages.json');
const languages = ['en', 'ru', 'fa', 'es', 'zh-cn'];
const messages = new Map(rows.map((row) => [row[0], row]));

const installerMessage = (language, key, ...values) => {
  const index = Math.max(0, languages.indexOf(language));
  const format = messages.get(key)?.[index] ?? key;
  let next = 0;
  // Callback replacement keeps dollar signs, percent signs and backslashes in
  // passwords and URLs literal. No printf syntax is accepted from caller data.
  return format.replace(/%s/g, () => String(values[next++] ?? ''));
};

module.exports = { installerMessage };
