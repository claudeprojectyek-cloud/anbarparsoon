// setup.js — از فایل‌های تخت (بدون پوشه) ساختار کامل پروژه‌ی اندروید را می‌سازد.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const R = __dirname;
const run = c => cp.execSync(c, { cwd: R, stdio: 'inherit' });
const put = (src, dst) => { const d = path.join(R, dst); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(R, src), d); };

// ۱) ساخت پوشه‌ی www
const MAP = {
  'index.html': 'index.html', 'login.html': 'login.html', 'category.html': 'category.html',
  'style.min.css': 'assets/css/style.min.css', 'vazirmatn-font-face.css': 'assets/css/vazirmatn-font-face.css',
  'Vazirmatn-wght.woff2': 'assets/fonts/Vazirmatn[wght].woff2',
  'icon-192.webp': 'assets/icons/icon-192.webp', 'icon-512.webp': 'assets/icons/icon-512.webp',
  'icon-192-maskable.webp': 'assets/icons/icon-192-maskable.webp', 'icon-512-maskable.webp': 'assets/icons/icon-512-maskable.webp',
  'bundle.min.js': 'assets/js/bundle.min.js',
  'offline-api.js': 'assets/js/offline/offline-api.js', 'native-extras.js': 'assets/js/offline/native-extras.js', 'seed-data.js': 'assets/js/offline/seed-data.js'
};
['bcrypt.min.js', 'chart.umd.min.js', 'docx.iife.js', 'html2canvas.min.js', 'jspdf.umd.min.js', 'qrcode.min.js', 'xlsx.full.min.js']
  .forEach(f => MAP[f] = 'assets/js/vendor/' + f);
fs.rmSync(path.join(R, 'www'), { recursive: true, force: true });
Object.keys(MAP).forEach(k => put(k, 'www/' + MAP[k]));

// ۲) پروژه‌ی اندروید
fs.rmSync(path.join(R, 'android'), { recursive: true, force: true });
run('npx cap add android');
const A = 'android/app/';
put('anbar-parsoon.jks', A + 'anbar-parsoon.jks');

const edit = (f, fn) => { const p = path.join(R, f); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
edit(A + 'build.gradle', s => s
  .replace('versionCode 1\n        versionName "1.0"', 'versionCode 30000\n        versionName "3.0.0"')
  .replace(/buildTypes \{\s*release \{/, `signingConfigs {
        anbar {
            storeFile file('anbar-parsoon.jks')
            storePassword 'anbar-parsoon-2026'
            keyAlias 'anbar'
            keyPassword 'anbar-parsoon-2026'
        }
    }
    buildTypes {
        debug { signingConfig signingConfigs.anbar }
        release {
            signingConfig signingConfigs.anbar`));
if (!fs.readFileSync(path.join(R, A + 'build.gradle'), 'utf8').includes('signingConfigs.anbar')) throw new Error('patch build.gradle failed');
edit(A + 'src/main/AndroidManifest.xml', s => s
  .replace('android:allowBackup="true"', 'android:allowBackup="true"\n        android:requestLegacyExternalStorage="true"')
  .replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />'));

// ۳) آیکن و صفحه‌ی شروع از لوگوی شرکت
fs.writeFileSync(path.join(R, 'icons.py'), `
from PIL import Image, ImageDraw
import glob
res = 'android/app/src/main/res/'
logo = Image.open('icon-512-maskable.webp').convert('RGBA')
bg = Image.new('RGBA', logo.size, (255,255,255,255)); bg.alpha_composite(logo); logo = bg
sizes = {'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}
fg = {'mdpi':108,'hdpi':162,'xhdpi':216,'xxhdpi':324,'xxxhdpi':432}
for d, s in sizes.items():
    p = res + 'mipmap-' + d + '/'
    sq = logo.resize((s, s), Image.LANCZOS); sq.save(p + 'ic_launcher.png')
    m = Image.new('L', (s, s), 0); ImageDraw.Draw(m).ellipse((0, 0, s-1, s-1), fill=255)
    rd = Image.new('RGBA', (s, s), (0, 0, 0, 0)); rd.paste(sq, (0, 0), m); rd.save(p + 'ic_launcher_round.png')
    logo.resize((fg[d], fg[d]), Image.LANCZOS).save(p + 'ic_launcher_foreground.png')
for f in glob.glob(res + 'drawable*/splash.png'):
    w, h = Image.open(f).size
    b = Image.new('RGBA', (w, h), (255,255,255,255)); side = int(min(w, h) * 0.42)
    b.alpha_composite(logo.resize((side, side), Image.LANCZOS), ((w-side)//2, (h-side)//2)); b.convert('RGB').save(f)
`);
run('python3 icons.py');
run('npx cap sync android');
console.log('SETUP OK');
