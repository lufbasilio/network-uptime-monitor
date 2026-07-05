# Network Monitor

Dashboard web leve para monitoramento de conectividade de internet, projetado para rodar em um **Raspberry Pi**. Processa um arquivo de log gerado por um cron job e exibe um painel em tempo real com histórico de quedas, timeline de eventos, gráfico de disponibilidade e histórico de IPs.

## Como funciona

Um cron job externo executa periodicamente uma verificação de conectividade e grava o resultado em um arquivo de log no formato:

```
YYYY-MM-DD HH:MM:SS - [IP]
```

- Se a internet está **online**: `2026-07-05 14:30:00 - 177.105.131.230`
- Se está **offline**: `2026-07-05 14:35:00 - `

O cron job realiza uma requisição HTTP para um serviço que retorna o IP externo da conexão. Se a requisição falhar (sem internet), a linha é gravada com o campo de IP vazio — indicando queda. O Network Monitor usa essa diferença para distinguir online de offline.

> **Exemplo de uso com NextDNS:** O autor utiliza o endpoint de IP do NextDNS (`https://link-ip.nextdns.io/...`) como alvo da requisição, pois além de retornar o IP externo, confirma que o DNS está operacional. Você pode adaptar para qualquer endpoint que retorne o IP público, como `https://api.ipify.org`.

O Network Monitor lê esse arquivo de forma incremental (sem reprocessar o histórico a cada requisição), mantém o estado em memória e expõe um dashboard via navegador.

## Funcionalidades

- **Status atual** — conectividade, IP externo, última leitura, quedas hoje
- **Gráfico de disponibilidade** — últimas 24h agrupadas por hora (verde = online, vermelho = qualquer queda na hora)
- **Histórico de quedas** — início, fim e duração de cada interrupção
- **Histórico de IPs** — registro de cada mudança de IP externo
- **Timeline de eventos** — todos os registros com filtro por data/hora e paginação
- **Atualização automática** a cada 30 segundos sem recarregar a página
- **Responsivo** — funciona em desktop e celular

## Pré-requisitos

- Node.js >= 18
- Um arquivo de log no formato descrito acima, gerado por um cron job

## Instalação

```bash
git clone https://github.com/seu-usuario/network-monitor.git
cd network-monitor
npm install --production
```

## Configuração

Copie o arquivo de exemplo e ajuste:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
LOG_FILE_PATH=/home/pi/network-check.log
PORT=3000
```

| Variável | Obrigatória | Descrição |
|---|---|---|
| `LOG_FILE_PATH` | ✅ Sim | Caminho absoluto para o arquivo de log |
| `PORT` | Não | Porta do servidor (padrão: `3000`) |

## Exemplo de cron job

O cron job deve gravar uma linha no formato `YYYY-MM-DD HH:MM:SS - [IP]` a cada intervalo. O IP é obtido via `curl` para qualquer endpoint que retorne o IP externo. Se o `curl` falhar (sem internet), o campo fica vazio — indicando queda.

Adicione ao crontab (`crontab -e`):

```bash
# Verifica conectividade a cada 5 minutos e mantém log com até 2000 linhas
*/5 * * * * echo "$(date '+\%Y-\%m-\%d \%H:\%M:\%S') - $(curl -s --max-time 10 https://api.ipify.org 2>/dev/null)" >> /home/pi/network-check.log && tail -n 2000 /home/pi/network-check.log > /tmp/net.tmp && mv /tmp/net.tmp /home/pi/network-check.log
```

**Endpoints alternativos para obter o IP externo:**

| Endpoint | Retorno |
|---|---|
| `https://api.ipify.org` | IP puro |
| `https://ifconfig.me/ip` | IP puro |
| `https://link-ip.nextdns.io/<profile>/<device>` | IP puro (NextDNS — também confirma que o DNS está ativo) |

> O `tail -n 2000` ao final mantém o arquivo compacto, evitando crescimento indefinido no Raspberry Pi.

## Uso

### Iniciar manualmente

```bash
node backend/server.js
```

Acesse `http://localhost:3000` no navegador.


## Deploy no Raspberry Pi

### 1. Transferir os arquivos

Via WinSCP (interface gráfica) ou scp, copie apenas estes arquivos/pastas para `/home/pi/network-monitor/`:

```
backend/
  server.js
  logStateManager.js
  fileWatcher.js
  routes/
    api.js
frontend/
  index.html
package.json
package-lock.json
.env.example
```

### 2. Instalar dependências no Pi

```bash
cd ~/network-monitor
npm install --production
```

> Se não tiver Node.js 18+:
> ```bash
> curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
> sudo apt-get install -y nodejs
> ```

### 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
nano .env
```

Defina `LOG_FILE_PATH` com o caminho real do seu arquivo de log.

### 4. Testar manualmente

```bash
node backend/server.js
```

Acesse `http://<IP_DO_PI>:3000` no navegador. Se funcionar, Ctrl+C e configure o serviço.

### 5. Criar serviço systemd (inicia no boot)

```bash
sudo nano /etc/systemd/system/network-monitor.service
```

```ini
[Unit]
Description=Network Monitor
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/network-monitor
EnvironmentFile=/home/pi/network-monitor/.env
ExecStart=/usr/bin/node backend/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> Ajuste `User` e `WorkingDirectory` se seu usuário não for `pi`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable network-monitor
sudo systemctl start network-monitor
```

### 6. Verificar

```bash
sudo systemctl status network-monitor
```

### Comandos úteis

| Ação | Comando |
|---|---|
| Reiniciar | `sudo systemctl restart network-monitor` |
| Ver logs | `journalctl -u network-monitor -f` |
| Parar | `sudo systemctl stop network-monitor` |

## Estrutura do projeto

```
network-monitor/
├── backend/
│   ├── server.js           # Entrypoint Express
│   ├── logStateManager.js  # Estado em memória + parsing incremental
│   ├── fileWatcher.js      # Monitoramento do arquivo de log
│   └── routes/
│       └── api.js          # Rotas REST
├── frontend/
│   └── index.html          # Dashboard (HTML + TailwindCSS + JS vanilla)
├── .env.example            # Template de configuração
├── package.json
└── README.md
```

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/status` | Status atual, IP, quedas hoje |
| GET | `/api/history` | Histórico de quedas |
| GET | `/api/timeline` | Registros paginados (aceita `page`, `pageSize`, `from`, `to`) |
| GET | `/api/chart` | Dados do gráfico (últimas 24h) |
| GET | `/api/ip-history` | Histórico de mudanças de IP |

## Tecnologias

- **Backend**: Node.js + Express (sem banco de dados — estado em memória)
- **Frontend**: HTML puro + TailwindCSS via CDN + JavaScript vanilla
- **Monitoramento de arquivo**: `fs.watchFile` (polling, compatível com Raspberry Pi)
