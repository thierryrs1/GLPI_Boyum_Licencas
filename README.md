# Integração GLPI & Portal BEAS/Boyum - Automação de Chamados

Projeto para extração automática das datas de vencimento de licenças diretamente do **Boyum Portal** (`portal.boyum-it.com`) e abertura automática de chamados no **GLPI** com notificação via **Microsoft Teams**.

## Arquivos do Projeto
- [app.js](file:///c:/Users/Admin/Desktop/Teste/GLPI/app.js): Centraliza toda a lógica de autenticação no Portal da Boyum, consulta JSON das assinaturas e licenças perpétuas (`/SubscriptionsReport/Load` e `/PerpetualLicensesReport/Load`), filtragem por Installation Number / Cliente, abertura de chamado na API REST do GLPI e disparo para o Webhook do Teams.
- [beas_license_extractor.src](file:///c:/Users/Admin/Desktop/Teste/GLPI/beas_license_extractor.src): Script auxiliar em BeasScript caso deseje extrair localmente do SAP B1.

## Como Usar o `app.js`

### 1. Consultar todas as licenças que vencem nos próximos 45 dias (padrão):
```bash
node app.js
```

### 2. Filtrar apenas licenças do BEAS que vencem em até 60 dias:
```bash
node app.js --beas --dias=60
```

### 3. Consultar um cliente específico pelo Installation Number ou Nome:
```bash
node app.js 0090811709
node app.js 0090500996
node app.js HELIANTO
```

### 4. Abrir chamados automaticamente no GLPI para licenças vencendo (somente `Auto-Renewal: Não`):
*(O envio ao Teams está desativado por padrão via `ENVIAR_TEAMS_ATIVO = false` em `app.js`)*

Parâmetros configurados na abertura do chamado no GLPI:
- **Entidade:** `SPS Group > Atendimento externo` (ID `1`)
- **Tipo:** `Incidente` (`1`)
- **Categoria:** `Manufatura > Beas > Produção` (ID `126`)
- **Origem da Requisição:** `IA` (ID `8`)
- **Requerente:** `thierry.silva@spsgroup.com.br` (ID `2545`)
- **Grupo Atribuído:** `SPS > Manufatura` (ID `6`)
- **Itens:** `Appliance > Beas` (ID `5`)

```bash
# Criar apenas 1 chamado de teste (apenas licenças sem Auto-Renewal):
node app.js --beas --dias=45 --teste-chamado

# Criar para todas as licenças BEAS (sem Auto-Renewal) vencendo em até 30 dias:
node app.js --beas --dias=30 --criar-chamado
```

## Variáveis de Ambiente (`.env`)
- `BOYUM_USER`: Usuário de acesso ao Portal da Boyum.
- `BOYUM_PASS`: Senha de acesso ao Portal da Boyum.
- `TOKEN_GLPI` / `USER_TOKEN`: Token do usuário no GLPI.
- `APPTOKEN_GLPI`: Token da aplicação do GLPI.
- `WEBHOOK_TEAMS`: Webhook para notificações de chamados criados.

