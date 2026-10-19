# AVEART — Frete sul-africano com Shiplogic / The Courier Guy

## O que esta integração adiciona

- Endpoint público de cotação: `POST /store/aveart-shipping/quote`.
- Consulta a API Shiplogic em `https://api.shiplogic.com/rates` usando token mantido no servidor.
- Exige endereço de recolha do fornecedor, endereço de entrega na África do Sul e volumes com peso e dimensões.
- Devolve a resposta original de tarifas da transportadora em ZAR.
- Valida os campos recebidos e não expõe o token nem as mensagens técnicas da API ao cliente.
- Não cria envios, etiquetas ou cobranças; apenas consulta tarifas.

## Variável necessária no Render

Adicionar ao serviço Medusa:

```env
SHIPLOGIC_API_TOKEN=<token de API da conta Shiplogic/The Courier Guy>
```

Obter o token no portal da transportadora/Shiplogic. A conta de teste e a conta de produção podem usar tokens/contas diferentes. Não colocar o token no frontend, no GitHub ou em variáveis `NEXT_PUBLIC_*`.

## Pedido de teste

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

Exemplo de chamada (substituir a chave publicável e o domínio):

```bash
curl -X POST "https://aveart-medusa-api.onrender.com/store/aveart-shipping/quote" \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: YOUR_MEDUSA_PUBLISHABLE_KEY" \
  --data @quote-test.json
```

## Como incorporar o frete nos preços dos produtos

A origem varia por fornecedor e o custo muda conforme destino, peso faturável, volume, serviço e sobretaxas. Por isso, não se deve adicionar um número fixo inventado a todos os produtos.

Próxima fase recomendada:
1. Guardar origem/código postal e dimensões embaladas em cada variante/fornecedor.
2. Consultar tarifas reais para uma amostra representativa de destinos sul-africanos.
3. Calcular a média/percentil de segurança por origem e perfil de embalagem.
4. Aprovar a regra comercial (média nacional ou preço por zona) e só então atualizar preços de catálogo em lote.
5. Manter a resposta de cotação disponível para auditoria e rever os preços periodicamente.

**Limitação atual:** este commit implementa a consulta de tarifas, não altera automaticamente os preços de produtos. Para fazer isso com segurança ainda precisamos de uma conta/API ativa e dados reais de origem, peso e dimensões dos fornecedores. Sem token válido, o endpoint responde `503 shipping_provider_not_configured` em vez de inventar tarifas.
