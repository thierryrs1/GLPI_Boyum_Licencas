const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

/**
 * Carrega as variáveis do arquivo .env sem precisar de pacotes externos
 */
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    const envVars = {};

    if (!fs.existsSync(envPath)) {
        return envVars;
    }

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex !== -1) {
            const key = trimmed.substring(0, eqIndex).trim();
            const val = trimmed.substring(eqIndex + 1).trim();
            envVars[key] = val;
        }
    }
    return envVars;
}

const env = loadEnv();
const BASE_URL_GLPI = 'https://suportespsgroup.datacore.com.br/apirest.php';
const APP_TOKEN = env.APPTOKEN_GLPI;
const USER_TOKEN = env.TOKEN_GLPI || env.USER_TOKEN;
const WEBHOOK_TEAMS = env.WEBHOOK_TEAMS;
const BOYUM_USER = env.BOYUM_USER || env.CLIENT_USER;
const BOYUM_PASS = env.BOYUM_PASS;
const BOYUM_PORTAL_URL = 'https://portal.boyum-it.com';

// Parâmetros fixos mapeados no GLPI da SPS Group
const GLPI_CONFIG = {
    TYPE_INCIDENTE: 1, // 1 = Incidente
    CATEGORY_BEAS_PRODUCAO: 126, // Manufatura > Beas > Produção
    REQUEST_TYPE_IA: 8, // IA
    USER_REQUESTER_THIERRY: 2545, // thierry.silva@spsgroup.com.br
    GROUP_SPS_MANUFATURA: 6, // SPS > Manufatura
    APPLIANCE_BEAS_ID: 5, // Appliance > Beas
    ENTITY_ATENDIMENTO_EXTERNO: 1 // SPS Group > Atendimento externo
};

// Flag para manter envio ao Teams desativado por padrão
const ENVIAR_TEAMS_ATIVO = false;

/**
 * Função utilitária para requisições HTTPS nativas com suporte a Cookies
 */
function request(urlStr, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(urlStr, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = data;
                try {
                    parsed = data ? JSON.parse(data) : {};
                } catch (err) {
                    // Mantém como texto/HTML caso não seja JSON
                }
                resolve({
                    status: res.statusCode,
                    data: parsed,
                    raw: data,
                    headers: res.headers
                });
            });
        });

        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Extrai e mescla cookies de cabeçalhos Set-Cookie
 */
function mergeCookies(existingCookies, setCookieHeader) {
    const cookieMap = {};
    if (existingCookies) {
        existingCookies.split(';').forEach((pair) => {
            const parts = pair.trim().split('=');
            if (parts.length >= 2) {
                cookieMap[parts[0]] = parts.slice(1).join('=');
            }
        });
    }
    if (Array.isArray(setCookieHeader)) {
        setCookieHeader.forEach((cookieStr) => {
            const firstPart = cookieStr.split(';')[0].trim();
            const eqIdx = firstPart.indexOf('=');
            if (eqIdx !== -1) {
                const k = firstPart.substring(0, eqIdx);
                const v = firstPart.substring(eqIdx + 1);
                cookieMap[k] = v;
            }
        });
    }
    return Object.entries(cookieMap)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

/**
 * Realiza login no Portal da Boyum (portal.boyum-it.com) e retorna os cookies de sessão
 */
async function loginPortalBoyum() {
    if (!BOYUM_USER || !BOYUM_PASS) {
        throw new Error('Credenciais BOYUM_USER / BOYUM_PASS não configuradas no .env');
    }

    const getLogin = await request(`${BOYUM_PORTAL_URL}/Account/Login`, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    let cookies = mergeCookies('', getLogin.headers['set-cookie']);
    const tokenMatch = getLogin.raw.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/);
    if (!tokenMatch) {
        throw new Error('Não foi possível obter o __RequestVerificationToken do Portal da Boyum.');
    }

    const verificationToken = tokenMatch[1];
    const formBody = querystring.stringify({
        Email: BOYUM_USER,
        Password: BOYUM_PASS,
        RememberMe: 'false',
        __RequestVerificationToken: verificationToken,
        returnUrl: '/PartnerEndCustomer'
    });

    const postLogin = await request(`${BOYUM_PORTAL_URL}/Account/LogIn`, {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formBody),
            'Cookie': cookies
        }
    }, formBody);

    cookies = mergeCookies(cookies, postLogin.headers['set-cookie']);

    if (postLogin.status !== 302 && !String(postLogin.raw).includes('Thierry')) {
        throw new Error(`Falha no login do Portal Boyum (HTTP ${postLogin.status})`);
    }

    return cookies;
}

/**
 * Busca todas as licenças (Assinaturas + Licenças Perpétuas) no Portal da Boyum
 */
async function obterLicencasPortalBoyum(filtroInstallationOrCustomer = '') {
    const cookies = await loginPortalBoyum();
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookies,
        'X-Requested-With': 'XMLHttpRequest'
    };

    const [subRes, perpRes] = await Promise.all([
        request(`${BOYUM_PORTAL_URL}/SubscriptionsReport/Load?IncludeInactiveSubscriptions=false`, { method: 'GET', headers }),
        request(`${BOYUM_PORTAL_URL}/PerpetualLicensesReport/Load`, { method: 'GET', headers })
    ]);

    const subscriptions = (subRes.data && Array.isArray(subRes.data.data)) ? subRes.data.data : [];
    const perpetuals = (perpRes.data && Array.isArray(perpRes.data.data)) ? perpRes.data.data : [];

    const hoje = new Date();
    const listaUnificada = [];

    for (const item of subscriptions) {
        const endDateStr = item.SubscriptionEndDate ? item.SubscriptionEndDate.split('T')[0] : null;
        const vencimento = endDateStr ? new Date(endDateStr) : null;
        const diasRestantes = vencimento ? Math.ceil((vencimento.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24)) : null;

        listaUnificada.push({
            tipo: 'Subscription',
            id: item.SubscriptionId,
            cliente: (item.CustomerName || '').trim(),
            produto: (item.Product || '').trim(),
            installationNumber: item.InstallationNumbersDisplay || (item.InstallationNumbers || []).join(', '),
            quantidade: item.SubscriptionQuantity,
            dataInicio: item.SubscriptionStartDate ? item.SubscriptionStartDate.split('T')[0] : '',
            dataVencimento: endDateStr,
            diasRestantes,
            autoRenewal: Boolean(item.SubscriptionAutoRenewal),
            status: item.SubscriptionStatus
        });
    }

    for (const item of perpetuals) {
        const endDateStr = item.ToDate ? item.ToDate.split('T')[0] : null;
        const vencimento = endDateStr ? new Date(endDateStr) : null;
        const diasRestantes = vencimento ? Math.ceil((vencimento.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24)) : null;

        listaUnificada.push({
            tipo: 'Perpetual',
            id: item.LicenseId,
            cliente: (item.CompanyName || '').trim(),
            produto: (item.ProductAndEditionName || item.ProductName || '').trim(),
            installationNumber: item.CustomerInstallationNumbersDisplayName || '',
            quantidade: item.Quantity,
            dataInicio: item.FromDate ? item.FromDate.split('T')[0] : '',
            dataVencimento: endDateStr,
            diasRestantes,
            autoRenewal: !item.MaintenanceCanceled,
            status: item.Status
        });
    }

    if (filtroInstallationOrCustomer) {
        const termo = filtroInstallationOrCustomer.toLowerCase();
        return listaUnificada.filter((lic) =>
            lic.installationNumber.toLowerCase().includes(termo) ||
            lic.cliente.toLowerCase().includes(termo) ||
            lic.produto.toLowerCase().includes(termo)
        );
    }

    return listaUnificada;
}

/**
 * Inicia sessão na API REST do GLPI
 */
async function initGlpiSession() {
    const res = await request(`${BASE_URL_GLPI}/initSession`, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Content-Type': 'application/json',
            'Authorization': `user_token ${USER_TOKEN}`,
            'App-Token': APP_TOKEN
        }
    });
    if (res.status < 200 || res.status >= 300 || !res.data.session_token) {
        throw new Error(`Erro ao autenticar no GLPI (HTTP ${res.status}): ${res.raw}`);
    }
    return res.data.session_token;
}

/**
 * Encerra sessão na API REST do GLPI
 */
async function killGlpiSession(sessionToken) {
    await request(`${BASE_URL_GLPI}/killSession`, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Session-Token': sessionToken,
            'App-Token': APP_TOKEN
        }
    });
}

/**
 * Cria um chamado de renovação de licença no GLPI com todos os parâmetros solicitados:
 * - Tipo: Incidente (1)
 * - Categoria: Manufatura > Beas > Produção (126)
 * - Origem da requisição: IA (8)
 * - Requerente: Thierry Silva (2545)
 * - Atribuído: SPS > Manufatura (6)
 * - Itens: Appliance > Beas (5)
 * - Entidade: SPS Group > Atendimento externo (1)
 */
async function criarChamadoRenovacaoBeas(dadosLicenca) {
    const sessionToken = await initGlpiSession();
    try {
        const titulo = `[BEAS/Boyum] Renovação de Licença - ${dadosLicenca.cliente} (${dadosLicenca.dataVencimento})`;
        const descricao = [
            '<h3>Alerta Automático de Vencimento de Licença (Boyum Portal)</h3>',
            `<p><strong>Cliente:</strong> ${dadosLicenca.cliente}</p>`,
            `<p><strong>Produto / Módulo:</strong> ${dadosLicenca.produto} (${dadosLicenca.tipo})</p>`,
            `<p><strong>Installation / System Number:</strong> ${dadosLicenca.installationNumber}</p>`,
            `<p><strong>Quantidade de Usuários/Terminais:</strong> ${dadosLicenca.quantidade}</p>`,
            `<p><strong>Data de Vencimento:</strong> ${dadosLicenca.dataVencimento}</p>`,
            `<p><strong>Dias Restantes:</strong> ${dadosLicenca.diasRestantes} dias</p>`,
            `<p><strong>Auto-Renewal no Portal:</strong> ${dadosLicenca.autoRenewal ? 'Sim' : 'Não'}</p>`
        ].join('\n');

        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Content-Type': 'application/json',
            'Session-Token': sessionToken,
            'App-Token': APP_TOKEN
        };

        const payload = {
            input: {
                name: titulo,
                content: descricao,
                entities_id: GLPI_CONFIG.ENTITY_ATENDIMENTO_EXTERNO,
                type: GLPI_CONFIG.TYPE_INCIDENTE,
                itilcategories_id: GLPI_CONFIG.CATEGORY_BEAS_PRODUCAO,
                requesttypes_id: GLPI_CONFIG.REQUEST_TYPE_IA,
                status: 2, // Em atendimento (atribuído)
                urgency: 4, // Alta
                impact: 4,
                priority: 4,
                _users_id_requester: GLPI_CONFIG.USER_REQUESTER_THIERRY,
                _groups_id_assign: GLPI_CONFIG.GROUP_SPS_MANUFATURA
            }
        };

        const res = await request(`${BASE_URL_GLPI}/Ticket`, {
            method: 'POST',
            headers
        }, payload);

        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Erro ao criar chamado no GLPI (HTTP ${res.status}): ${res.raw}`);
        }

        const ticketCriado = res.data;

        if (ticketCriado && ticketCriado.id) {
            // 1. Garante vínculo de Requerente (Ticket_User type=1)
            await request(`${BASE_URL_GLPI}/Ticket_User`, {
                method: 'POST',
                headers
            }, {
                input: {
                    tickets_id: ticketCriado.id,
                    users_id: GLPI_CONFIG.USER_REQUESTER_THIERRY,
                    type: 1 // 1 = Requerente
                }
            });

            // 2. Garante vínculo do Grupo Atribuído: SPS > Manufatura (Group_Ticket type=2)
            await request(`${BASE_URL_GLPI}/Group_Ticket`, {
                method: 'POST',
                headers
            }, {
                input: {
                    tickets_id: ticketCriado.id,
                    groups_id: GLPI_CONFIG.GROUP_SPS_MANUFATURA,
                    type: 2 // 2 = Atribuído
                }
            });

            // 3. Vincula o Item: Appliance > Beas (Item_Ticket)
            await request(`${BASE_URL_GLPI}/Item_Ticket`, {
                method: 'POST',
                headers
            }, {
                input: {
                    tickets_id: ticketCriado.id,
                    itemtype: 'Appliance',
                    items_id: GLPI_CONFIG.APPLIANCE_BEAS_ID
                }
            });
        }

        return ticketCriado;
    } finally {
        await killGlpiSession(sessionToken);
    }
}

/**
 * Envia notificação para o Webhook do Microsoft Teams (Atualmente desativado conforme solicitado)
 */
async function notificarTeams(dadosLicenca, ticketId = 'Simulação') {
    if (!ENVIAR_TEAMS_ATIVO || !WEBHOOK_TEAMS) return;

    const payload = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            size: 'Large',
                            weight: 'Bolder',
                            text: '⚠️ Alerta de Vencimento - Licença Boyum / BEAS'
                        },
                        {
                            type: 'FactSet',
                            facts: [
                                { title: 'Cliente:', value: String(dadosLicenca.cliente) },
                                { title: 'Produto:', value: String(dadosLicenca.produto) },
                                { title: 'Instalação:', value: String(dadosLicenca.installationNumber) },
                                { title: 'Vencimento:', value: String(dadosLicenca.dataVencimento) },
                                { title: 'Dias Restantes:', value: `${dadosLicenca.diasRestantes} dias` },
                                { title: 'Chamado GLPI:', value: `#${ticketId}` }
                            ]
                        }
                    ]
                }
            }
        ]
    };

    await request(WEBHOOK_TEAMS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, payload);
}

/**
 * Executa a varredura no Portal da Boyum, filtra apenas AutoRenewal = false ("Não"),
 * exibe o relatório e opcionalmente cria os chamados no GLPI
 */
async function executarMonitoramentoPortalBeas(opcoes = {}) {
    const {
        filtro = '',
        diasAlerta = 45,
        abrirChamados = false,
        apenasUmTeste = false,
        apenasBeas = false
    } = opcoes;

    console.log('Autenticando no Portal da Boyum (portal.boyum-it.com)...');
    let licencas = await obterLicencasPortalBoyum(filtro);

    if (apenasBeas) {
        licencas = licencas.filter((l) => l.produto.toLowerCase().includes('beas'));
    }

    // Filtra apenas licenças com Auto-Renewal = Não (false), pois "Sim" renova sozinho e não precisa abrir chamado
    const semAutoRenewal = licencas.filter((l) => !l.autoRenewal);

    // Ordena pelas que vencem mais cedo
    semAutoRenewal.sort((a, b) => (a.diasRestantes ?? 99999) - (b.diasRestantes ?? 99999));

    const vencendo = semAutoRenewal.filter((l) => l.diasRestantes !== null && l.diasRestantes <= diasAlerta);

    console.log(`Total de licenças consultadas: ${licencas.length} | Sem Auto-Renewal: ${semAutoRenewal.length}`);

    if (filtro) {
        console.log(`\n=== RESULTADO SEM AUTO-RENEWAL PARA FILTRO: "${filtro}" ===`);
        console.table(semAutoRenewal.map((l) => ({
            Cliente: l.cliente.substring(0, 35),
            Produto: l.produto.substring(0, 35),
            Installation: l.installationNumber.split('_')[0],
            Qtd: l.quantidade,
            Vencimento: l.dataVencimento,
            DiasRestantes: l.diasRestantes,
            AutoRenewal: l.autoRenewal ? 'Sim' : 'Não'
        })));
    } else {
        console.log(`\n=== LICENÇAS (AUTO-RENEWAL: NÃO) VENCENDO EM ATÉ ${diasAlerta} DIAS (${vencendo.length} encontradas) ===`);
        console.table(vencendo.map((l) => ({
            Cliente: l.cliente.substring(0, 35),
            Produto: l.produto.substring(0, 35),
            Installation: l.installationNumber.split('_')[0],
            Qtd: l.quantidade,
            Vencimento: l.dataVencimento,
            DiasRestantes: l.diasRestantes,
            AutoRenewal: l.autoRenewal ? 'Sim' : 'Não'
        })));
    }

    if (abrirChamados && vencendo.length > 0) {
        const listaParaAbrir = apenasUmTeste ? vencendo.slice(0, 1) : vencendo;
        for (const lic of listaParaAbrir) {
            console.log(`Abrindo chamado no GLPI para: ${lic.cliente} - ${lic.produto} (Vence em ${lic.dataVencimento})...`);
            const ticket = await criarChamadoRenovacaoBeas(lic);
            console.log(` -> Chamado GLPI criado com sucesso! ID: #${ticket.id}`);
            await notificarTeams(lic, ticket.id);
        }
    }

    return { total: licencas.length, semAutoRenewal: semAutoRenewal.length, vencendo };
}

module.exports = {
    GLPI_CONFIG,
    loginPortalBoyum,
    obterLicencasPortalBoyum,
    initGlpiSession,
    criarChamadoRenovacaoBeas,
    notificarTeams,
    executarMonitoramentoPortalBeas
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const filtroArg = args.find((a) => !a.startsWith('--')) || '';
    const diasArg = args.find((a) => a.startsWith('--dias='));
    const diasAlerta = diasArg ? parseInt(diasArg.split('=')[1], 10) : 45;
    const abrirChamados = args.includes('--criar-chamado') || args.includes('--teste-chamado');
    const apenasUmTeste = args.includes('--teste-chamado');
    const apenasBeas = args.includes('--beas');

    executarMonitoramentoPortalBeas({
        filtro: filtroArg,
        diasAlerta,
        abrirChamados,
        apenasUmTeste,
        apenasBeas
    }).catch((err) => {
        console.error('Erro na execução:', err.message);
        process.exit(1);
    });
}
