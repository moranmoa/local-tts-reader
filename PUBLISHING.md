# פרסום התוסף — Chrome ו-Firefox

## 0. בנייה
```powershell
node build.mjs
```
נוצרים:
- `dist/local-tts-reader-chrome-<version>.zip` — להעלאה ל-Chrome Web Store
- `dist/local-tts-reader-firefox-<version>.zip` — להעלאה ל-addons.mozilla.org (AMO)

בכל עדכון: מעלים את `version` ב-[manifest.json](manifest.json) ובונים מחדש. החנויות לא מקבלות אותה גרסה פעמיים.

## 1. בדיקה מקומית לפני פרסום
**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → התיקייה הראשית (או `dist/chrome`).

**Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → בוחרים את `dist/firefox/manifest.json`.
התוסף נשאר טעון רק עד שסוגרים את Firefox.

בדיקת תקינות של Mozilla (מוריד את הכלי מ-npm):
```powershell
npx web-ext lint --source-dir dist/firefox
```

## 2. Chrome Web Store
1. נרשמים ב-https://chrome.google.com/webstore/devconsole (תשלום רישום חד-פעמי של 5$).
2. **New item** → מעלים את ה-zip של Chrome.
3. **Store listing:** תיאור, קטגוריה (Accessibility), אייקון 128 (`icons/icon-128.png`), לפחות צילום מסך אחד בגודל 1280×800 או 640×400.
4. **Privacy practices:** ממלאים את ההצדקות (טקסט מוכן למטה), ומסמנים שהתוסף לא אוסף נתונים.
5. **Submit for review.** בגלל `<all_urls>` הבדיקה יכולה לקחת יותר זמן מהרגיל (בדרך כלל ימים, לפעמים יותר).

## 3. Firefox (AMO)
1. לפני ההעלאה הראשונה משנים את `FIREFOX_ID` ב-[build.mjs](build.mjs) למזהה משלך (למשל `local-tts-reader@your-domain`) ובונים מחדש. אחרי ההעלאה הראשונה אי אפשר לשנות אותו.
2. נכנסים ל-https://addons.mozilla.org/developers/ (חינם) → **Submit a New Add-on**.
3. בוחרים:
   - **On this site** — מפורסם ב-AMO ומופיע בחיפוש.
   - **On your own** — AMO רק חותם על הקובץ ומחזיר `.xpi` שאפשר להתקין ולהפיץ לבד.
4. מעלים את ה-zip של Firefox. הקוד לא מכווץ ולא עבר minify, אז אין צורך להגיש קוד מקור בנפרד.
5. ממלאים תיאור ומדיניות פרטיות (טקסט למטה).

## 4. טקסטים מוכנים להדבקה (באנגלית)

**Single purpose (Chrome):**
> Reads web page text aloud using the computer's local text-to-speech voices: selected text, the whole page, or a user-chosen section such as a live chat.

**Permission justifications:**
- `tts` — Speaks text with the browser's text-to-speech engine, restricted to local (offline) voices.
- `storage` — Saves the user's voice and speed settings.
- `scripting` — Reads the selected text, the page text, or the section the user picks, only after the user clicks the extension.
- `contextMenus` — Adds a "Read selected text aloud" item to the right-click menu.
- `activeTab` — Accesses the current tab when the user invokes the extension.
- Host permission `<all_urls>` — The user can read any page, including live chats inside iframes (e.g. YouTube live chat), and the chosen chat section keeps being read as new messages arrive.

**Privacy policy:**
> Local TTS Reader does not collect, store, or transmit any personal data. Page text is read only on the user's device and is spoken with local text-to-speech voices; it is never sent to any server. The only stored data is the user's voice and speed preference, kept in the browser's extension storage.

בחנות של Chrome צריך לפעמים לתת קישור למדיניות הפרטיות. אפשר לשים את הטקסט הזה בדף פשוט, למשל ב-GitHub Pages או ב-Gist ציבורי.
