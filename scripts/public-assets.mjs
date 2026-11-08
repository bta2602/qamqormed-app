const modules = ['app', 'api', 'dom', 'i18n', 'ui', 'screens', 'clinical', 'catalog', 'admin'];
const icons = ['house', 'stethoscope', 'calendar-days', 'flask-conical', 'pill', 'hospital', 'messages-square',
    'user-round', 'users-round', 'shield-check', 'heart-pulse', 'moon', 'log-out', 'arrow-right', 'arrow-left',
    'refresh-cw', 'key-round', 'chevron-left', 'chevron-right', 'plus', 'pencil', 'file-heart', 'check', 'x',
    'trash-2', 'circle-x', 'clock', 'inbox', 'sparkles', 'list', 'map', 'locate-fixed'];
export const publicAssets = [
    ['index.html', 'index.html'], ['web/styles.css', 'web/styles.css'],
    ...modules.map(name => [`web/${name}.mjs`, `web/${name}.mjs`]),
    ['web/fonts/manrope.ttf', 'web/fonts/manrope.ttf'], ['web/fonts/Manrope-OFL.txt', 'web/fonts/Manrope-OFL.txt'],
    ...icons.map(name => [`node_modules/lucide-static/icons/${name}.svg`, `web/icons/${name}.svg`]),
    ['node_modules/lucide-static/LICENSE', 'web/icons/LICENSE'],
    ['node_modules/leaflet/dist/leaflet-src.esm.js', 'web/vendor/leaflet.mjs'],
    ['node_modules/leaflet/dist/leaflet.css', 'web/vendor/leaflet.css'],
    ['node_modules/leaflet/LICENSE', 'web/vendor/LICENSE'],
    ...['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']
        .map(name => [`node_modules/leaflet/dist/images/${name}`, `web/vendor/images/${name}`]),
];
