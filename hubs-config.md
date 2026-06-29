# Configuração de Hubs — Cardetail1

## Estratégia de Hubs

Em vez de criar dezenas de landing pages por cidade, agrupamos a cobertura em **poucas páginas-hub** — uma por condado/região — com uma **cidade-âncora** que concentra SEO local e conteúdo relevante. Cada hub representa um raio amplo de atendimento móvel: o visitante vê conteúdo localizado (bairros, referências, prova social da região) sem fragmentar o site em centenas de URLs.

**Benefícios:**
- Menos páginas para manter, mais autoridade por URL
- Cobertura ampla (Tri-State) com mensagem local credível
- Entrada pelo ZIP na home → redirecionamento automático ao hub correto
- Reserva e precificação continuam nas páginas de hub (ou na home, conforme decisão abaixo)

---

## Mapa de Hubs

| Hub | Cidade-âncora | Cidades / bairros cobertos | Arquivo | Status |
|-----|---------------|----------------------------|---------|--------|
| **Bergen County** | Hackensack | Palisades Park, Englewood, Teaneck, Paramus, Fort Lee | `bergen-county-hub.html` | ✅ Ativo |
| **Hudson County** | Jersey City | Hoboken, Bayonne, Union City | `hudson-county-hub.html` | ✅ Ativo |
| **Essex County** | Newark | Elizabeth, Bloomfield, West Orange | `essex-county-hub.html` | ✅ Ativo |
| **Passaic County** | Paterson | Franklin Lakes, Wayne, Clifton | `passaic-county-hub.html` | ✅ Ativo |
| **NY Metro** | Manhattan | Westchester, Bronx, Queens | `ny-metro-hub.html` | ✅ Ativo |
| **Connecticut** | Waterbury | Danbury, New Haven, Hartford, Stamford | `connecticut-hub.html` | ✅ Ativo |

### Detalhe por hub

- **HUB: Bergen County** (Âncora: Hackensack) — Palisades Park, Englewood, Teaneck, Paramus, Fort Lee — `bergen-county-hub.html`
- **HUB: Hudson County** (Âncora: Jersey City) — Hoboken, Bayonne, Union City — `hudson-county-hub.html`
- **HUB: Essex County** (Âncora: Newark) — Elizabeth, Bloomfield, West Orange — `essex-county-hub.html`
- **HUB: Passaic County** (Âncora: Paterson) — Franklin Lakes, Wayne, Clifton — `passaic-county-hub.html`
- **HUB: NY Metro** (Âncora: Manhattan) — Westchester, Bronx, Queens — `ny-metro-hub.html`
- **HUB: Connecticut** (Âncora: Waterbury) — Danbury, New Haven, Hartford, Stamford — `connecticut-hub.html`

> **Status:** implementado — 6 hubs ativos (`index.html` redirect + páginas-hub).

---

## Faixas de ZIP por hub (referência)

Derivado de `ZIP_CITIES`, `ZIP_ZONES` e `netlify/lib/travel-fee.js` em `index.html`. Prefixos de 3 dígitos (ZIP3); ZIPs específicos podem ser refinados na implementação.

| Hub | Prefixos ZIP3 principais | Exemplos (ZIP5) |
|-----|--------------------------|-----------------|
| **Bergen** | `076`, `074` (maioria), `070` (Fort Lee, Edgewater, Fairview, Cliffside Park) | 07650 Palisades Park, 07601 Hackensack, 07631 Englewood, 07666 Teaneck, 07652 Paramus, 07024 Fort Lee |
| **Hudson** | `073`, `070` (Hoboken, North Bergen, Weehawken, Union City, West New York, Secaucus, Kearny) | 07030 Hoboken, 07047 North Bergen, 07086 Weehawken, 07087 Union City, 07093 West New York, 07302 Jersey City |
| **Essex** | `071`, `070` (Newark metro: Montclair, Bloomfield, West Orange, Maplewood, Glen Ridge, Orange) | 07102 Newark, 07104 Newark, 07042 Montclair, 07003 Bloomfield, 07052 West Orange, 07201 Elizabeth* |
| **Passaic** | `075`, `074` (Wayne, Franklin Lakes, Pompton), `070` (Clifton, Passaic, Wallington) | 07501 Paterson, 07470 Wayne, 07417 Franklin Lakes, 07011 Clifton, 07055 Passaic |
| **NY Metro** | `100`–`104`, `111`–`114` (NYC), `105`–`107` (Westchester), `109` (Rockland — opcional) | 10001 Manhattan, 10451 Bronx, 11354 Queens, 10583 Scarsdale, 10601 White Plains |
| **Connecticut** | `060`–`069` | 06708 Waterbury, 06810 Danbury, 06510 New Haven, 06103 Hartford, 06901 Stamford |

\* Elizabeth (`072xx`) está em Union County; incluir em **Essex** hub por proximidade operacional a Newark, ou mapear para hub próprio no futuro.

**Fora dos 6 hubs (permanecem na home ou hub estendido):**
- `078`–`089` — NJ Other (`nj_b` em `ZIP_ZONES`)
- `115`–`119`, `117` — Long Island
- `180`–`191` — Pennsylvania
- Demais prefixos dentro de `TRAVEL_MAX_MILES` (150 mi) — fallback abaixo

---

## Próximo Passo — Proposta: ZIP → Hub (redirect)

> **Status:** implementado em `index.html` (`HUB_PAGES`, `resolveHubByZip`, redirect no hero ZIP).

### 1. Pontos de código em `index.html`

| Elemento | Linhas | Função |
|----------|--------|--------|
| Hero ZIP input + botão Check | **1458–1478** | `#hero-zip`, `oninput="onHeroZipInput"`, `onclick="onHeroZipSubmit()"` |
| `ZIP_CITIES` (lookup cidade) | **5644–5979** | Mapa ZIP5 → nome da cidade |
| `applyTravelForZip` / `resolveZipService` | **6026–6042** | Valida raio de serviço + taxa de deslocamento |
| `ZIP_ZONES` + `getZoneByZip` | **6045–6086** | Prefixos ZIP3 → zona comercial (`nj_a`, `nyc`, etc.) |
| `onBkZipInput` (modal reserva) | **6132–6163** | Desbloqueia booking + preços locais |
| **`onHeroZipInput`** | **7761–7801** | Feedback visual, pills, sync booking, **abre modal** após 350 ms |
| **`onHeroZipSubmit`** | **7807–7820** | Valida 5 dígitos → chama `onHeroZipInput` → scroll para `#before-after` |

**Função principal a modificar:** `onHeroZipSubmit()` (linha **7807**).

**Função secundária:** extrair lógica de redirect de `onHeroZipInput()` (linha **7761**) — hoje ela faz unlock de cards, sync `bk-zip`, abre booking e atualiza preços; o redirect deve rodar **no submit**, não a cada keystroke após 5 dígitos.

**Nova função sugerida:** `resolveHubByZip(zip5)` — inserir após `getZoneByZip` (~linha **6086**), junto de `ZIP_ZONES`.

Referência server-side espelhada: `netlify/lib/travel-fee.js` (`ZIP_ZONE_PREFIXES`, linhas **34–44**).

---

### 2. Objeto JS proposto — `HUB_BY_ZIP3`

```javascript
const HUB_PAGES = {
  bergen:  'bergen-county-hub.html',
  hudson:  'hudson-county-hub.html',
  essex:   'essex-county-hub.html',
  passaic: 'passaic-county-hub.html',
  nyMetro: 'ny-metro-hub.html',
  connecticut: 'connecticut-hub.html',
};

// Prefixos ZIP3 → hub (prioridade: match mais específico primeiro)
const HUB_ZIP3_PREFIXES = {
  bergen:  ['076', '074'],
  hudson:  ['073'],
  essex:   ['071'],
  passaic: ['075'],
  nyMetro: ['100', '101', '102', '103', '104', '111', '112', '113', '114', '105', '106', '107'],
  connecticut: ['060', '061', '062', '063', '064', '065', '066', '067', '068', '069'],
};

// ZIP5 específicos que sobrescrevem o prefixo (condados mistos em 070xx)
const HUB_ZIP5_OVERRIDES = {
  // Hudson
  '07030': 'hudson', '07032': 'hudson', '07047': 'hudson', '07086': 'hudson',
  '07087': 'hudson', '07093': 'hudson', '07094': 'hudson',
  // Essex
  '07003': 'essex', '07028': 'essex', '07040': 'essex', '07042': 'essex', '07043': 'essex',
  '07044': 'essex', '07050': 'essex', '07052': 'essex', '07201': 'essex', '07202': 'essex',
  // Passaic
  '07011': 'passaic', '07012': 'passaic', '07013': 'passaic', '07014': 'passaic',
  '07055': 'passaic', '07407': 'passaic', '07424': 'passaic',
  // Bergen (070xx no norte)
  '07010': 'bergen', '07020': 'bergen', '07022': 'bergen', '07024': 'bergen',
  '07026': 'bergen', '07031': 'bergen', '07057': 'bergen', '07070': 'bergen',
  '07071': 'bergen', '07072': 'bergen', '07073': 'bergen', '07074': 'bergen', '07075': 'bergen',
};

function resolveHubByZip(zip) {
  const z = String(zip).replace(/\D/g, '').slice(0, 5);
  if (z.length < 5) return null;
  const hubKey = HUB_ZIP5_OVERRIDES[z]
    || Object.entries(HUB_ZIP3_PREFIXES).find(([, prefs]) => prefs.includes(z.slice(0, 3)))?.[0]
    || null;
  return hubKey ? { key: hubKey, page: HUB_PAGES[hubKey] } : null;
}
```

---

### 3. Pseudocódigo — fluxo no hero ZIP

```
onHeroZipSubmit():
  zip5 = sanitize(hero-zip)
  if len(zip5) < 5 → erro inline, return

  svc = applyTravelForZip(zip5)   // mantém validação de raio 150 mi
  if !svc → mensagem "fora da área" (comportamento atual), return

  hub = resolveHubByZip(zip5)

  if hub:
    // Opcional: persistir para hub page
    sessionStorage.setItem('cd1_zip', zip5)
    sessionStorage.setItem('cd1_hub', hub.key)

    // Feedback breve (~400 ms) antes do redirect
    hero-zip-feedback = "📍 {cityName} → redirecionando para {hub.label}..."
    hero-zip.classList.add('valid')

    setTimeout(() => {
      window.location.href = hub.page + '?zip=' + zip5
    }, 400)
    return

  // Fallback (ZIP válido mas sem hub mapeado)
  → ver seção 4
```

**Alternativa scroll + redirect** (menos recomendada): scroll para `#before-after` e redirect após 1,2 s — hoje `onHeroZipSubmit` já faz scroll (linha **7816–7818**); substituir esse scroll por redirect quando hub existir.

**Parâmetro `?zip=`:** permite ao hub pré-preencher hero/booking e aplicar `applyTravelForZip` localmente.

---

### 4. Fallback quando ZIP não está no mapa

| Cenário | Comportamento sugerido |
|---------|------------------------|
| ZIP válido (dentro de 150 mi), sem hub | Redirect para **`bergen-county-hub.html`** (base operacional em Palisades Park) **ou** manter fluxo atual na home |
| ZIP fora de 150 mi | Sem redirect — mensagem de erro atual em `onHeroZipInput` (linhas **7770–7778**) |
| ZIP inválido (< 5 dígitos) | Erro inline em `onHeroZipSubmit` (linhas **7807–7812**) |

**Recomendação:** hub default = **`bergen-county-hub.html`** para ZIPs em `nj_b`, CT, LI, PA ainda atendidos mas sem página dedicada. Evita dead-end na home para áreas servidas.

---

### 5. Preços na home vs redirect-only

| Opção | Prós | Contras |
|-------|------|---------|
| **A — Redirect-only no hero** (recomendado) | SEO local por hub; menos duplicação; visitante vê conteúdo da região | Requer hub pages com ZIP gate + booking |
| **B — Manter preços na home + redirect opcional** | Transição suave; home continua funcionando | Duas experiências; hero ainda abre booking (linha **7798–7800**) |
| **C — Híbrido** | Hero mostra cidade + "Ver preços locais →" por 400 ms, depois redirect; booking só no hub | Melhor UX durante migração |

**Recomendação: Opção C (híbrido de transição)**

1. **Remover** de `onHeroZipInput` (quarters **7791–7800**): `_unlockHomeCards`, sync `bk-zip`, `openBooking()` automático — quando redirect estiver ativo.
2. **Manter** na home: carousel genérico, chat, CTA "Book" sem ZIP obrigatório no hero.
3. **Nas hub pages:** reutilizar bloco ZIP + `applyTravelForZip` + modal booking (copiar de `index.html` ou `westchester-mobile-detailing.html`).

Assim o hero da home vira **porta de entrada geográfica**, não calculadora de preço.

---

### 6. Checklist de implementação

- [x] Criar os 6 arquivos `*-hub.html` (incl. `connecticut-hub.html`)
- [x] Adicionar `HUB_PAGES` + `resolveHubByZip` em `index.html`
- [x] Alterar `onHeroZipSubmit` para welcome card + redirect no clique (`showHubWelcomeCard`, `continueToHubBooking`)
- [x] Hub pages: ler `?zip=` / `sessionStorage.cd1_zip` no load (`initHubZipFromQuery`)
- [ ] Refatorar `onHeroZipInput` — validação inline sem abrir booking
- [ ] Testes: amostra de ZIP por hub + fallback + fora de área
- [ ] Alinhar `travel-fee.js` se lógica de zona for compartilhada no build

---

*Documento gerado para revisão — sem alterações em `index.html` ou commits.*
