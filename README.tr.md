# Compose Upgrade Risk Inspector (Immich için)

[English](README.md) | **Türkçe**

Bir [Immich](https://immich.app) Docker Compose projesini okuyan, çevrimdışı ve salt okunur bir komut satırı aracı. İki Immich sürümü arasındaki yükseltmede hangi belgelenmiş değişikliklerin **zorunlu** olduğunu, hangilerinin **önerildiğini** ve dosyalara bakarak hangilerinin **karar verilemediğini** raporlar. Her bulgu, dayandığı resmî kaynağı gösterir.

Bu belge kısa bir Türkçe tanıtımdır. Ayrıntılı teknik başvuru kaynağı İngilizce [README](README.md) ve [`docs/`](docs/) klasörüdür.

> **Durum: araştırma / portföy prototipi, v0.2.2 ön sürüm (pre-release).**
> - Bağımsız bir projedir. **Immich ile bağlantılı değildir, Immich tarafından onaylanmamıştır.**
> - **Çevrimdışı ve salt okunurdur.** Yükseltme yapmaz; Docker veya Compose dosyalarını değiştirmez; Docker'a, veritabanına, ağa veya bir dil modeline bağlanmaz.
> - **Resmî Immich yükseltme talimatlarının yerini tutmaz.** Sürüm notlarını okuyun ve yükseltmeden önce yedek alın.
> - Güvenliği, uyumluluğu veya eksiksizliği **garanti etmez**. Veritabanının gerçek durumunu ve Docker imajlarının erişilebilirliğini **doğrulamaz**.
> - **Üretim ortamında kullanım için doğrulanmamıştır.** Bilinen bir müşteri kurulumu yoktur.

## Hangi sorunu çözüyor?

Immich hızlı gelişen bir proje. Bazı sürümler Compose kurulumunda elle değişiklik gerektiriyor:
- yeniden adlandırılan ya da kaldırılan ortam değişkenleri;
- kaldırılan container'lar ve başlatma komutları;
- doğrudan atlanamayan ara sürümler;
- pgvecto.rs'ten VectorChord'a geçiş.

Bu adımlar birçok sürüm notuna, dokümantasyon sayfasına ve bir geçiş rehberine dağılmış durumda. Hangilerinin sizi etkilediği de kendi dosyalarınıza bağlı. Araç, belirli bir sürüm aralığı için Compose'ta görülebilen belgelenmiş adımları tek bir raporda, kaynaklarıyla birlikte toplar. Dosyalar karar vermeye yetmediğinde bunu açıkça söyler.

## Nasıl çalışır?

Araç tek bir çalışma zamanı bağımlılığı olan (`yaml`, `package-lock.json` ile sabitlenmiş) bir Node.js CLI'dır. Compose dosyalarınızın bulunduğu klasörü, şu an çalışan sürümü (`--current`) ve hedef sürümü (`--target`) verirsiniz.

Araç şunları okur:
- `compose.yaml` / `docker-compose.yml`;
- değişken yerleştirmesi için proje `.env` dosyası;
- `env_file:` girdileri ve `environment:` blokları.

Sonucu terminalde gösterir; `--json` ile aynı veriyi JSON olarak verir. Proje klasörünün dışındaki dosyaları, kabuk ortam değişkenlerini ve ağı hiç kullanmaz.

```bash
node bin/cri.mjs analyze <compose-klasörü> --current vX.Y.Z --target vX.Y.Z [--json]
```

## Neyi analiz ediyor?

Immich **v1.102.0 – v3.4.0-rc.3** aralığında altı risk ailesi, **23 kural ve 2 yükseltme yolu kısıtı**:

| Aile | Örnek kontroller |
|---|---|
| F1 Ortam değişkenleri | v1.106 port/host adı değişiklikleri (servis bazında), v1.119'da `HOST` → `IMMICH_HOST`, kaldırılan metrik değişkenleri, v3'te kaldırılan değişkenler |
| F2 Servis mimarisi | v1.118'de `start.sh` komutlarının ve `immich-microservices` container'ının kaldırılması, sunucu portu |
| F3 Doğrudan yükseltme alt sınırı | v1.133.0 ve üzeri hedefler için çalışan sürüm en az v1.107.2 olmalı |
| F4 Zorunlu ara geçiş | v1.137.0 ve üzeri hedefler için önce v1.132–v1.136 aralığında başarılı bir açılış gerekir |
| F5 PostgreSQL / VectorChord | v3'te eski pgvecto.rs imajında desteklenen vektör eklentisi yok; 2.x için geçiş önerileri |
| F6 pgvecto.rs'in kaldırılması | v3, `DB_VECTOR_EXTENSION=pgvecto.rs` değerini reddeder; eski `vectors.so` komutları |

Bu aralığın dışındaki sürümler (örneğin incelenmemiş `v3.4.0`) `UNSUPPORTED_VERSION` sonucuyla reddedilir.

## Bulgular ve UNKNOWN sonucu

| Etiket | Anlamı |
|---|---|
| `ACTION_REQUIRED` | Resmî bir kaynak bu hedef için değişikliği zorunlu kılıyor ve tetikleyici dosyalarınızda görünüyor. |
| `ADVISORY` | Resmî bir kaynak değişikliği öneriyor, ama henüz zorunlu değil. |
| `UNKNOWN` | Girdiler karar vermeye yetmiyor: eksik dosya, çözülemeyen değişken, bilinmeyen çalışan sürüm, harici veritabanı vb. **Bu bir "geçti" sonucu değildir;** bulgu neyin eksik olduğunu yazar. |
| `NOT_APPLICABLE` | Girdiler tam ve o ailenin hiçbir desteklenen kuralı eşleşmedi. **Bu bir güvenlik kararı değildir.** |

- **Kaynak gösterilir.** Her bulgu kaynak kimliğini, URL'yi ve revizyonu ([EVIDENCE.md](EVIDENCE.md)) taşır.
- **Bilinçli olarak `OK` veya `SAFE` sonucu yoktur.** Genel durum en fazla `NO_KNOWN_RISK_IN_COVERED_RULES` olabilir; bu da yalnızca "desteklenen kurallardan hiçbiri eşleşmedi" demektir.

## Üç çalıştırılabilir örnek

Üçü de yer tutucu değerler kullanan sentetik projelerdir. Her klasörde girdiler, kesin komut, kaydedilmiş gerçek terminal ve JSON çıktıları ve kısa bir açıklama var. `test/examples.test.mjs` bu çıktıları her çalıştırmada bayt düzeyinde karşılaştırır.

```bash
npm ci
node bin/cri.mjs analyze examples/02-intermediate-upgrade-stop --current v1.131.3 --target v1.137.0
```

| Örnek | Yükseltme | Ne gösteriyor |
|---|---|---|
| [01-env-variable-migration](examples/01-env-variable-migration/) | v1.118.2 → v1.119.0 | `ACTION_REQUIRED`: `HOST` → `IMMICH_HOST` ve kaldırılan metrik değişkenleri |
| [02-intermediate-upgrade-stop](examples/02-intermediate-upgrade-stop/) | v1.131.3 → v1.137.0 | `INTERMEDIATE_REQUIRED`: önce v1.132.3'e geçilmeli; ayrıca VectorChord imajı için `ADVISORY` |
| [03-external-database-unknown](examples/03-external-database-unknown/) | v2.7.5 → v3.0.0 | `UNKNOWN`: harici veritabanı v3'teki pgvecto.rs kaldırılması açısından kontrol edilemiyor; rapor nedenini yazıyor |

## Test ve doğrulama

| Tür | Sonuç |
|---|---|
| GitHub Actions (Node.js 24.22.2) | **Ubuntu: 179/179, Windows: 179/179 test geçti**; lint ve fixture doğrulaması da geçti |
| Yerel çalıştırma (Windows, Node.js 24.16.0) | 178 geçti, 1 atlandı: dosya sembolik bağlantısı testi yerelde yetki gerektiriyor; CI'da iki ortamda da geçti |
| Geliştirme seti | 41 sentetik vakada 41/41. Vakalar ve cevap anahtarları kuralları yazan kişi tarafından hazırlandı; **gerçek dünya doğruluğu ölçüsü değildir** |
| Mutasyon testi | Bilerek eklenen 61 hatanın 61'i test seti tarafından yakalandı |
| Üretim doğrulaması | **Yapılmadı** |

Yalnızca Node.js 24 test edildi. `package.json` `>=20` beyan ediyor, ancak **Node.js 20/22 ve macOS test edilmedi**. Ayrıntılar: [docs/testing.md](docs/testing.md).

## Temel tasarım kararları

- **Üç değerli mantık.** Her kontrol doğru, yanlış ya da bilinmiyor sonucu verir. Karar verilemeyen bir kontrol hiçbir zaman sessizce "uygulanmaz" sayılmaz.
- **Kurallar veri, motor genel.** Kurallar ve kaynak kaydı YAML dosyalarında durur ve yükleme sırasında denetlenir. Kullanıcıya gösterilen talimat serbest metinden değil, doğrulanmış yapısal `remediation` alanından üretilir.
- **Servisleri tanıma.** İmajlar tam depo adıyla eşleştirilir, alt dize ile değil. Veritabanı servisi Immich'in yaptığı gibi bulunur (`DB_URL`, sonra `DB_HOSTNAME`, varsayılan `database`). Eski değişkenler yalnızca onları okuyan serviste kontrol edilir. Özel bir `entrypoint:` servis kimliğini belirsiz yapar.
- **Güvenli yeniden adlandırma.** Bir değişken yeniden adlandırıldığında, yazılan değerin ulaşacağı her servis kontrol edilir. Bir servis aynı değişken için iki farklı değer alacaksa, mevcut farklı bir değerin üzerine yazılacaksa ya da paylaşılan bir `.env` başka bir servisin varsayılanını değiştirecekse araç düz bir "yeniden adlandır" talimatı vermez. Bunun yerine çakışmayı bildirir ya da "önce doğrulayın" der; hiçbir zaman bir değeri kendisi seçmez.
- **Gizli bilgi yok.** Değişken değerleri, değişken yerleştirmeyle gelen değerler, imaj etiketleri ve `DB_URL` raporda gösterilmez. Hata mesajları kullanıcının girdiği değeri tekrarlamaz.
- **Belgelenmiş çıktı sözleşmesi.** JSON çıktısının kendi sürümü (`schema: 3`) ve belgelenmiş çıkış kodları var: `0` analiz tamamlandı, `2` girdi/şema/kural hatası, `3` desteklenmeyen sürüm, `1` beklenmeyen hata.

## Önemli sınırlamalar

- **Kapsam dar.** Yalnızca Immich, yalnızca F1–F6 aileleri ve yalnızca Compose dosyalarında görülebilen kısım kontrol edilir. API, mobil uygulama, donanım ve yönetici ayarları kapsam dışıdır.
- **Bazı Compose özellikleri birleştirilmez.** `extends`, `include:`, override dosyaları ve birden çok Compose dosyası işlenmez; ilgili kontroller `UNKNOWN` olur.
- **Veritabanına bağlanılmaz.** Gerçek eklenti durumu bilinemez. İmaj erişilebilirliği kontrol edilmez.
- **Sürüm aralığı sabit.** v3.4.0-rc.3'ten yeni sürümler, sürüm notları incelenene kadar desteklenmez.
- **Kaynaklar değişebilir.** Resmî kaynaklar düzenlenebilir; araç belirli revizyonlara dayanır.
- **Bilinçli olarak temkinli.** Paylaşılan dosyalar ve özel `entrypoint:` gibi durumlarda gereğinden fazla `UNKNOWN` üretebilir.

Tam liste: [docs/limitations.md](docs/limitations.md).

## Bu proje neyi gösteriyor?

Proje, dağınık resmî kaynakları denetlenebilir ve test edilebilir kurallara dönüştürmenin bir örneği. Öne çıkan mühendislik tercihleri şunlar:
- **Belirsizliği gizlememek:** `UNKNOWN` birinci sınıf bir sonuç, `OK` ise hiç yok.
- **Her iddiayı kaynağa bağlamak.**
- **Talimat metnini serbest metin yerine yapısal veriden üretmek.**
- **Çıktıda gizli bilgi sızdırmamak.**
- **Her inceleme bulgusunu önce başarısız bir test olarak yeniden üretmek, sonra düzeltmek.**
- **Doğrulamayı katmanlı kurmak:** regresyon testleri, ayrı yazılmış bir "golden" kayıt, geliştirme seti, mutasyon testi ve iki platformda CI.

Sonuçlar dürüstçe sınırlandırılmıştır: yüksek geliştirme seti puanı bir doğruluk iddiası değildir, ve araç üretim kullanımı için doğrulanmamıştır.

## Yapay zekâ destekli geliştirme ve bağımsız inceleme

Proje, yapay zekâ destekli mühendislik araçlarıyla iki ayrı rolde geliştirildi:
- **Geliştirme:** kod, testler ve belgeler, proje sahibinin yönlendirmesiyle **Claude Code** (Anthropic) ile yazıldı.
- **İnceleme:** kod ve davranış, geliştirmeden ayrı olarak **Codex** (OpenAI) ile birkaç tur incelendi.

Bu bir dış sertifika, insan tarafından yapılmış bir güvenlik denetimi veya üretim onayı değildir. Ayrıntılar: [docs/development-process.md](docs/development-process.md).

## Kaynaklar, lisans ve bağımsızlık

- **Kaynaklar.** [EVIDENCE.md](EVIDENCE.md) tüm kaynakları (E01–E25) URL ve revizyonlarıyla listeler. Immich sürüm notları ve dokümanları sahiplerine aittir. Bu depoda kopyaları yoktur; yalnızca bağlantılar, revizyon bilgileri ve kısa alıntılar bulunur.
- **Lisans.** Projenin kendi kodu ve belgeleri [MIT Lisansı](LICENSE) ile yayınlanır. Üçüncü taraf materyaller bu lisansın kapsamında değildir.
- **Bağımsızlık.** "Immich" bağımsız bir açık kaynak projesinin adıdır. Bu proje Immich veya bakımcılarıyla **bağlantılı değildir, onlar tarafından onaylanmamış ve desteklenmemektedir.**

## Ayrıntılı İngilizce belgeler

- [README.md](README.md): ana belge, örnek çıktılar ve sürüm politikası
- [docs/architecture.md](docs/architecture.md): mimari ve değerlendirme akışı
- [docs/testing.md](docs/testing.md): test ve CI sonuçları
- [docs/limitations.md](docs/limitations.md): sınırlamalar
- [docs/development-process.md](docs/development-process.md): geliştirme ve inceleme süreci
- [CHANGELOG.md](CHANGELOG.md): sürüm geçmişi
