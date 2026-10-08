# coderep

Windsurf, Cursor ve Claude Code gibi ajanlı editörler için iki şey yapar:

1. Bir ajan turu kodu bozduğunda **hangi düzenlemenin bozduğunu** bulup geri
   alır — gerçek git geçmişinize tek satır eklemeden.
2. Ajanın projeyi baştan taramak yerine **doğrudan doğru fonksiyona inmesini**
   sağlar, böylece her pencerede aynı token'ı yeniden harcamaz.

```
$ coderep bisect -- npm test

  #1 25eb2298  7sn önce → kaldı  ajan adim 9
  #2 e943b55c  9sn önce → geçti  ajan adim 0
  #3 87942a8f  8sn önce → geçti  ajan adim 4
  #4 3f7330a7  8sn önce → kaldı  ajan adim 6
  #5 b4f592ed  8sn önce → geçti  ajan adim 5

Bozulmayı getiren snapshot: 3f7330a7
  ne zaman  8sn önce
  dosyalar  2
      M	src/auth.js
      A	src/helper-6.js

Öncesine dön: coderep restore b4f592ed
```

## Neden

Ajan bir turda sekiz dosyaya dokunuyor, bir şey bozuluyor, ve elinizde tek bir
commit bile yok. `git stash` ve ara commit disiplini ajan hızında çalışmıyor;
çalışsa bile gerçek geçmişinizi çöplüyor. Editörlerin kendi "checkpoint"
özellikleri ise editöre kilitli ve `npm test` gibi bir kontrolle ilişkilendirilemiyor.

coderep her dosya kaydında sessizce snapshot alır, sonra bir kontrol komutu
verdiğinizde ikili aramayla bozulmayı getiren **tek** düzenlemeyi bulur.

## Kurulum

```bash
npx coderep init      # config + editörlerin MCP girdileri
coderep watch         # arka planda snapshot almaya başla
```

`init`, Windsurf (`.windsurf/mcp_config.json`), Cursor (`.cursor/mcp.json`) ve
Claude Code (`.mcp.json`) için MCP girdilerini yazar. Editörü yeniden başlatın.

## Komutlar

| Komut | İş |
|---|---|
| `coderep watch` | Yazma bitince (varsayılan 500ms) otomatik snapshot |
| `coderep snap -m "..."` | Elle snapshot |
| `coderep log --since 2h` | Zaman çizelgesi |
| `coderep diff <id> [<id2>]` | Snapshot'lar arası, ya da snapshot ↔ çalışma dizini |
| `coderep bisect -- npm test` | Komutu bozan ilk snapshot'ı bul |
| `coderep restore <id> [--files ...]` | Geri al — önce mevcut durumu snapshot'lar |
| `coderep status` | Watcher, snapshot sayısı, disk |
| `coderep prune --older-than 7d` | Eskileri sil |
| `coderep index [--stats]` | Sembol indeksini kur/yenile |
| `coderep find <sorgu>` | Feature'ın dosya ve sembolünü bul |
| `coderep outline <dosya>` | Sadece imzalar |
| `coderep map [--budget 2000]` | Token bütçesine sığan repo haritası |
| `coderep feature add\|list\|rm\|suggest` | Feature → yol haritası |

`restore` her zaman geri alınabilir: çıktıdaki `coderep restore <pre-restore-id>`
komutu sizi geri aldığınız yere döndürür.

## Feature'ın yerini bulma

Ajana "login akışında şunu yap" demek için önce yerini bulması gerekir. Normalde
bunu glob'layıp tam dosyalar okuyarak yapar; coderep sembol indeksinden tek
atışta söyler.

```
$ coderep find "login"

app/routers/auth.py:7  login [route]
  @router.post("/api/login") async def login(credentials: dict)
  Authenticate a user and issue a session token.
  tam ad + literal · skor 12.49
```

```
$ coderep outline packages/index/src/graph.ts

packages/index/src/graph.ts
  · 11-57     function  rankFiles
      export function rankFiles(entries: FileEntry[]): void
```

### Türkçe sorgular

Kod İngilizce, sorgu Türkçe olduğunda alias tanımlarsınız:

```bash
coderep feature add login "src/auth/**" --alias "giriş" --alias "oturum açma"
coderep find "giriş"     # "login" ile aynı sonucu verir
```

`coderep feature suggest` koda bakıp aday feature'ları önerir.

### Ne kadar token tasarrufu?

Uydurma bir yüzde yerine ölçüm var. `pnpm measure` iki yolu karşılaştırır:
naif yol (grep + çıkan ilk 5 tam dosyayı okumak) ile coderep yolu
(`find_feature` + en iyi isabetin `get_symbol`'ü).

coderep'in kendi reposunda, 5 sorguda:

```
sorgu                       naif   coderep     oran
bisect                      6179       703     8.8x
snapshot restore            3820       564     6.8x
symbol index                4636       341    13.6x
watcher debounce            5178       262    19.8x
repo map budget             8158       728    11.2x
TOPLAM                     27970      2597    10.8x
```

Kendi projenizde ölçmek için: `node scripts/measure-tokens.mjs /yol/proje`

### Nasıl çalışıyor

- **TS/JS/TSX:** `typescript` paketinin kendi AST'si. Program ve TypeChecker
  kurulmuyor, sadece sözdizimsel ağaç — bu yüzden hızlı. Gerçek
  `isExported`/JSDoc/JSX/decorator bilgisi verdiği için `LoginForm`'un bir
  bileşen, `useAuth`'un bir hook, `GET`'in bir route olduğunu biliyor.
  JSX metinleri de toplanıyor: bir butonun üstündeki "Giriş yap" etiketi, o
  feature'ı arayan birinin yazacağı kelimenin ta kendisi.
- **Python:** girinti yığını + parantez derinliği sayan satır tarayıcı.
  Decorator'ı imzaya dahil ettiği için FastAPI/Flask/Django route'ları
  bulunabilir oluyor.
- **Arama:** BM25; sembol adı, dosya yolu, doc/docstring ve string literal'ler
  üzerinde. Üstüne tam ad, feature alias'ı ve PageRank yükseltmeleri.
- **Artımlı:** içerik hash'i değişmeyen dosya yeniden parse edilmiyor.
  `coderep watch` zaten debounce ettiği için indeks yenilemesi aynı flush'ta
  koşuyor.

`web-tree-sitter` denenmedi ve gerekmedi: `tree-sitter-wasms@0.1.13` (Ekim 2025)
web-tree-sitter 0.25+ yükleyicisi tarafından reddediliyor ve 4 gramer için 51MB
indiriyor. `typescript` saf JS, sıfır bağımlılık ve sembol çıkarımında daha
isabetli. Bedeli: Go/Rust/Java eklemek ayrı iş.

## Git'inize dokunmaz

Snapshot'lar git'in nesne modelini kullanır ama **kendi deposunda** durur
(`.git/coderep/store`, ana reponun nesnelerine `alternates` ile bağlı — ortak
içerik iki kez saklanmaz). Staging ayrı bir `GIT_INDEX_FILE` üzerinden yapılır.

Sonuç olarak bunların hiçbiri coderep'ten etkilenmez:

```
git log        git log --all      git status     git branch
git stash      git show-ref       git fsck       .git/index
```

Snapshot'lar `refs/heads/*` altında olmadığı için `git push` ile uzağa da sızmaz.
Bu iddia testle sabitlenmiştir: 20 snapshot sonrası `.git/index` dosyasının
mtime'ı bile değişmez.

`.gitignore`, `.git/info/exclude` ve `.coderepignore` üçü de snapshot kapsamını
belirler — `node_modules` ve sırlarınız dışarıda kalır.

## MCP araçları

Editörünüzdeki ajan şunları çağırabilir:

| Araç | İş |
|---|---|
| `checkpoint_begin` / `checkpoint_end` | Ajan kendi turunu parantez içine alır |
| `checkpoint_list` | Son snapshot'lar |
| `checkpoint_diff` | Snapshot'lar arası fark |
| `checkpoint_bisect` | Bozulmayı getiren snapshot'ı bul |
| `checkpoint_restore` | Geri al — **varsayılan olarak kapalı** |
| `find_feature` | Sorguya göre sıralı dosya + sembol + satır |
| `get_symbol` | **Sadece o sembolün** kaynağı, tam dosya değil |
| `outline` | Bir dosyanın imzaları, gövdeleri olmadan |
| `references` | Düzenlemeden önce etki alanı |
| `repo_map` | Token bütçesine sığdırılmış sıralı harita |

`checkpoint_restore` varsayılanda reddeder ve bunun yerine kullanıcının
çalıştıracağı komutu döndürür. Kodu bozan ajanın sessizce geri sarması
istenen bir şey değil. Açmak için `.coderep/config.json` → `allowAgentRestore: true`.

## Yapılandırma

`.coderep/config.json`:

```json
{
  "version": 1,
  "allowAgentRestore": false,
  "debounceMs": 500,
  "watchIgnore": ["**/node_modules/**", "**/dist/**", "..."],
  "bisectLink": ["node_modules", ".venv"],
  "indexOnWatch": true
}
```

`indexOnWatch`, `coderep watch` çalışırken sembol indeksinin de aynı debounce
içinde yenilenmesini sağlar.

`bisectLink`, deneme worktree'sine sembolik bağ kurulacak klasörleri belirler —
`node_modules` bağlanmazsa `npm test` deneme dizininde çalışamaz.

## Yol haritası

- **Faz 3 — VS Code eklentisi.** Timeline görünümü, tek tıkla restore,
  kaydetme olayında snapshot. Bu paketin üstüne ince bir UI katmanı.
- **Daha fazla dil.** Go, Rust, Java. Mevcut iki parser'ın yanına üçüncü bir
  arka uç gerektiriyor.
- **Opsiyonel gömme (embedding) katmanı.** Alias tanımlamadan serbest Türkçe
  sorgu. Şu an sözlüksel arama + alias haritası var; deterministik ve
  çevrimdışı çalışıyor.

## Geliştirme

```bash
pnpm install
pnpm -r build
pnpm test
```

## Lisans

MIT
