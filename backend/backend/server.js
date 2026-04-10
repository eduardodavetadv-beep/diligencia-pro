const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const axios = require('axios');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Muitas requisições. Aguarde 1 minuto.' }
});
app.use('/api/', limiter);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function cleanCNPJ(v) { return (v || '').replace(/\D/g, ''); }
function cleanCPF(v)  { return (v || '').replace(/\D/g, ''); }

function axiosClient(extraHeaders = {}) {
  return axios.create({
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      ...extraHeaders
    }
  });
}

// ─── ROUTE: Receita Federal ───────────────────────────────────────────────────
app.get('/api/receita/:cnpj', async (req, res) => {
  const cnpj = cleanCNPJ(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido' });

  const cached = cache.get(`receita_${cnpj}`);
  if (cached) return res.json({ source: 'cache', ...cached });

  try {
    const { data } = await axiosClient().get(`https://publica.cnpj.ws/cnpj/${cnpj}`);
    cache.set(`receita_${cnpj}`, data);
    res.json({ source: 'api', ...data });
  } catch (e) {
    // Fallback: BrasilAPI
    try {
      const { data } = await axiosClient().get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      cache.set(`receita_${cnpj}`, data);
      res.json({ source: 'brasilapi', ...data });
    } catch (e2) {
      res.status(502).json({ error: 'Receita Federal indisponível', detail: e2.message });
    }
  }
});

// ─── ROUTE: CNJ DataJud ───────────────────────────────────────────────────────
// DataJud API pública (sem autenticação para consultas básicas)
app.post('/api/datajud', async (req, res) => {
  const { documento, tipo } = req.body;
  const doc = tipo === 'cnpj' ? cleanCNPJ(documento) : cleanCPF(documento);

  const cacheKey = `datajud_${doc}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', ...cached });

  const query = {
    query: {
      bool: {
        should: [
          { match: { "partes.documento": doc } },
          { match: { "partes.nome": documento } }
        ],
        minimum_should_match: 1
      }
    },
    size: 50,
    sort: [{ "dataAjuizamento": { order: "desc" } }]
  };

  try {
    // DataJud endpoint público CNJ
    const { data } = await axiosClient({
      'Content-Type': 'application/json',
    }).post(
      'https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search',
      query
    );

    const hits = data?.hits?.hits || [];
    const processos = hits.map(h => ({
      numero: h._source?.numeroProcesso,
      tribunal: h._source?.tribunal,
      classe: h._source?.classe?.nome,
      assunto: h._source?.assuntos?.[0]?.nome,
      dataAjuizamento: h._source?.dataAjuizamento,
      grau: h._source?.grau,
      orgaoJulgador: h._source?.orgaoJulgador?.nome,
      partes: h._source?.partes?.slice(0, 4),
      movimentos: h._source?.movimentos?.slice(0, 3),
      valor: h._source?.valorCausa
    }));

    const result = { total: data?.hits?.total?.value || 0, processos };
    cache.set(cacheKey, result);
    res.json({ source: 'datajud', ...result });
  } catch (e) {
    res.status(502).json({ error: 'DataJud indisponível', detail: e.message });
  }
});

// ─── ROUTE: CNJ DataJud — múltiplos tribunais ─────────────────────────────────
app.post('/api/datajud/todos', async (req, res) => {
  const { documento, tipo, nome } = req.body;
  const doc = tipo === 'cnpj' ? cleanCNPJ(documento) : cleanCPF(documento);

  const cacheKey = `datajud_todos_${doc}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', ...cached });

  // Índices públicos do DataJud por tribunal
  const INDICES = [
    'api_publica_tjsp', 'api_publica_tjrj', 'api_publica_tjmg',
    'api_publica_tjrs', 'api_publica_tjsc', 'api_publica_tjpr',
    'api_publica_tjba', 'api_publica_tjpe', 'api_publica_tjce',
    'api_publica_trf1', 'api_publica_trf2', 'api_publica_trf3',
    'api_publica_trf4', 'api_publica_trf5',
    'api_publica_tst',
  ];

  const query = {
    query: {
      bool: {
        should: [
          { match: { "partes.documento": doc } },
          ...(nome ? [{ match: { "partes.nome": { query: nome, fuzziness: "AUTO" } } }] : [])
        ],
        minimum_should_match: 1
      }
    },
    size: 100,
    sort: [{ "dataAjuizamento": { order: "desc" } }]
  };

  const client = axiosClient({ 'Content-Type': 'application/json' });
  const resultados = [];
  const erros = [];

  // Paraleliza as consultas (máx 5 simultâneas para não sobrecarregar)
  const chunks = [];
  for (let i = 0; i < INDICES.length; i += 5) {
    chunks.push(INDICES.slice(i, i + 5));
  }

  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map(async (indice) => {
        try {
          const { data } = await client.post(
            `https://api-publica.datajud.cnj.jus.br/${indice}/_search`,
            query
          );
          const hits = data?.hits?.hits || [];
          const total = data?.hits?.total?.value || 0;
          if (hits.length > 0 || total > 0) {
            resultados.push({
              tribunal: indice.replace('api_publica_', '').toUpperCase(),
              total,
              processos: hits.map(h => ({
                numero: h._source?.numeroProcesso,
                tribunal: h._source?.tribunal || indice.replace('api_publica_', '').toUpperCase(),
                classe: h._source?.classe?.nome,
                assunto: h._source?.assuntos?.[0]?.nome,
                dataAjuizamento: h._source?.dataAjuizamento,
                grau: h._source?.grau,
                orgaoJulgador: h._source?.orgaoJulgador?.nome,
                partes: (h._source?.partes || []).slice(0, 4).map(p => ({
                  nome: p.nome,
                  tipo: p.tipoParte?.nome,
                  doc: p.documento
                })),
                valor: h._source?.valorCausa,
                ultimoMovimento: h._source?.movimentos?.[0]?.nome
              }))
            });
          }
        } catch (e) {
          erros.push({ tribunal: indice, erro: e.message });
        }
      })
    );
  }

  // TST via API própria
  try {
    const { data } = await client.get(
      `https://consultaapi.tst.jus.br/api/processos/consultarProcessoPorCpfCnpj/${doc}`
    );
    const procs = Array.isArray(data) ? data : (data?.processos || []);
    if (procs.length > 0) {
      resultados.push({
        tribunal: 'TST',
        total: procs.length,
        processos: procs.slice(0, 50).map(p => ({
          numero: p.numeroProcesso || p.numero,
          tribunal: 'TST',
          classe: p.classeProcessual || 'Trabalhista',
          assunto: p.assunto,
          dataAjuizamento: p.dataAjuizamento,
          orgaoJulgador: p.orgaoJulgador || p.vara,
          valor: p.valorCausa,
          ultimoMovimento: p.situacao
        }))
      });
    }
  } catch (e) {
    erros.push({ tribunal: 'TST', erro: e.message });
  }

  const totalGeral = resultados.reduce((s, r) => s + r.total, 0);
  const result = { totalGeral, tribunais: resultados, erros, consultadoEm: new Date().toISOString() };
  cache.set(cacheKey, result);
  res.json({ source: 'datajud', ...result });
});

// ─── ROUTE: JusBrasil scraping via proxy ─────────────────────────────────────
app.get('/api/jusbrasil/:query', async (req, res) => {
  const q = decodeURIComponent(req.params.query);
  const cacheKey = `jb_${q}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', ...cached });

  try {
    // JusBrasil tem API pública de busca
    const { data } = await axiosClient({
      'Referer': 'https://www.jusbrasil.com.br/',
      'Accept': 'text/html,application/xhtml+xml'
    }).get(`https://www.jusbrasil.com.br/consulta-processual/search?q=${encodeURIComponent(q)}`);

    // Parse HTML com cheerio
    const cheerio = require('cheerio');
    const $ = cheerio.load(data);

    const processos = [];
    // Selectors do JusBrasil (podem mudar com atualizações do site)
    $('[data-testid="lawsuit-card"], .ProcessCard, .lawsuit-card').each((i, el) => {
      processos.push({
        numero: $(el).find('[data-testid="lawsuit-number"], .ProcessCard-number').text().trim(),
        tribunal: $(el).find('[data-testid="lawsuit-court"], .ProcessCard-court').text().trim(),
        classe: $(el).find('[data-testid="lawsuit-class"], .ProcessCard-class').text().trim(),
        assunto: $(el).find('[data-testid="lawsuit-subject"]').text().trim(),
        partes: $(el).find('[data-testid="lawsuit-parties"]').text().trim(),
        ultimaAtualizacao: $(el).find('[data-testid="lawsuit-last-update"]').text().trim(),
        url: 'https://www.jusbrasil.com.br' + ($(el).find('a').attr('href') || '')
      });
    });

    const result = { total: processos.length, processos, fonte: 'jusbrasil' };
    cache.set(cacheKey, result);
    res.json({ source: 'scraping', ...result });
  } catch (e) {
    res.status(502).json({
      error: 'JusBrasil indisponível ou bloqueou a requisição',
      detail: e.message,
      fallback: `https://www.jusbrasil.com.br/consulta-processual/?q=${encodeURIComponent(q)}`
    });
  }
});

// ─── ROUTE: Status / Health ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '2.0.0',
    cacheKeys: cache.keys().length,
    uptime: Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString()
  });
});

// ─── ROUTE: Frontend fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏛  DiligênciaPRO Backend rodando na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Cache TTL: 300s\n`);
});
