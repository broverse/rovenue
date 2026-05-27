// Expo loads `app.plugin.js` from the package root when the consumer
// adds the package to `"plugins"` in app.json. We delegate to the
// compiled TS plugin entry under plugin/build/.
module.exports = require("./plugin/build/index").default;
