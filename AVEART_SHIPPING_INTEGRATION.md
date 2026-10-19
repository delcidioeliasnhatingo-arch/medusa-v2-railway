# AVEART — Frete sul-africano com Shiplogic / The Courier Guy

## Estado desta entrega

- Endpoint implementado: `POST /store/aveart-shipping/quote`.
- Consulta a API Shiplogic em `https://api.shiplogic.com/rates`.
- Valida origem e destino sul-africanos e 1–20 volumes com dimensões em cm e peso em kg.
- Normaliza as tarifas e devolve os serviços ordenados pelo preço em ZAR.
- Não devolve a resposta técnica integral do fornecedor nem expõe o token.
- Não cria etiquetas, não agenda recolhas e não altera preços de produtos.

## Ativar no Render

Adicionar a variável ao serviço Medusa correto:

```env
SHIPLOGIC_API_TOKEN=<token da conta Shiplogic / The Courier Guy>
```

Obter o token diretamente no portal/apoio da transportadora. Não enviar o token por chat, não o colocar no GitHub e não o incluir no frontend. O token de teste e o token de produção podem corresponder a contas diferentes.

## Pedido de teste

Guardar como `quote-test.json`:

```json
{
  "collection_address": {
    "street_address": "10 Example Road",
    "local_area": "Kya Sand",
    "city": "Randburg",
    "zone": "GP",
    "country": "ZA",
    "code": "2163",
    "type": "business"
  },
  "delivery_address": {
    "street_address": "20 Example Street",
    "local_area": "Gardens",
    "city": "Cape Town",
    "zone": "WC",
    "country": "ZA",
    "code": "8001",
    "type": "residential"
  },
  "parcels": [
    {
      "submitted_length_cm": 30,
      "submitted_width_cm": 25,
      "submitted_height_cm": 5,
      "submitted_weight_kg": 0.6,
      "parcel_description": "Clothing"
    }
  ],
  "declared_value": 250
}
```

Executar depois do deploy, substituindo o domínio e a chave publicável:

```bash
curl -X POST "https://aveart-medusa-api.onrender.com/store/aveart-shipping/quote" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: YOUR_MEDUSA_PUBLISHABLE_KEY" \
  --data @quote-test.json
```

Resposta esperada em caso de sucesso: `provider`, `currency_code: "zar"`, códigos postais e uma lista `rates` com `service_code`, `service_name`, `amount_zar` e datas estimadas quando fornecidas pela transportadora. O formato real depende da conta/API e tem de ser confirmado com uma cotação autorizada.

## Política de frete incluído no preço

A AVEART vende com o frete estimado incorporado no preço do artigo. Como a origem muda por fornecedor e a tarifa muda por destino, não é seguro atualizar o catálogo com uma taxa fixa inventada.

Fluxo necessário antes da alteração em massa:
1. Registar no catálogo os dados reais de expedição de cada fornecedor: endereço/código postal, peso embalado e dimensões embaladas.
2. Definir uma amostra de destinos que represente as zonas onde a loja vende.
3. Consultar tarifas reais para os perfis de embalagem e rotas da amostra.
4. Calcular uma média ponderada ou percentil de segurança para cada perfil/origem, documentando o método e os suplementos incluídos.
5. Aplicar o frete estimado aos preços-base apenas depois de confirmar a regra comercial, os preços atuais e as margens.
6. Rever a tabela periodicamente; encomendas extraordinárias e envios múltiplos podem precisar de tratamento específico.

**Bloqueios para concluir a ativação real:** token Shiplogic válido, autorização para selecionar o workspace Render correto, endereço de origem real por fornecedor e dimensões/pesos reais dos produtos. Sem estes dados, o endpoint responde com erro explícito em vez de inventar uma tarifa ou modificar preços incorretamente.
