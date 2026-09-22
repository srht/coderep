# coderep

Windsurf, Cursor ve Claude Code gibi ajanlı editörlerde bir tur kodu bozduğunda,
**hangi düzenlemenin bozduğunu** bulup geri almanızı sağlar — gerçek git
geçmişinize tek bir satır bile eklemeden.

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

`restore` her zaman geri alınabilir: çıktıdaki `coderep restore <pre-restore-id>`
komutu sizi geri aldığınız yere döndürür.

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
  "bisectLink": ["node_modules", ".venv"]
}
```

`bisectLink`, deneme worktree'sine sembolik bağ kurulacak klasörleri belirler —
`node_modules` bağlanmazsa `npm test` deneme dizininde çalışamaz.

## Yol haritası

- **Faz 2 — kod haritası.** tree-sitter ile TS/JS ve Python sembol indeksi,
  `find_feature(query)` ve `get_symbol(file, name)` MCP araçları. Ajan tam
  dosya okumak yerine tek fonksiyonu alır; token kullanımı buradan düşer.
- **Faz 3 — VS Code eklentisi.** Timeline görünümü ve tek tıkla restore.
  Bu paketin üstüne ince bir UI katmanı.

## Geliştirme

```bash
pnpm install
pnpm -r build
pnpm test
```

## Lisans

MIT
