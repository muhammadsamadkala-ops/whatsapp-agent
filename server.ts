/**
 * KEVI BELION - WHATSAPP PERFUME SHOP ASSISTANT
 * ================================================
 * Ye server WhatsApp se aane wale customer messages sunta hai, unhein
 * Agentic AI (Groq) ko bhejta hai, jo catalog dikha sakta hai, orders le
 * sakta hai, aur owner ko naye order ki WhatsApp par notification bhejta hai.
 */

import express, { Request, Response } from 'express';
import Groq from 'groq-sdk';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'groq-sdk/resources/chat/completions';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN!;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN!;
// Owner's WhatsApp number - naya order aane par isi number par notification jayegi.
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER || '923152292047';

const groqClient = new Groq();
const MODEL = 'openai/gpt-oss-120b';
const BUSINESS_NAME = 'Kevi Belion';

// ---------------------------------------------------------------------------
// PRODUCT CATALOG
// ---------------------------------------------------------------------------
// Ye aapki apni perfume list hai - isay edit kar ke apne asal products,
// prices, aur descriptions daal dein. Har product ka structure same rakhein.
interface Product {
  name: string;
  priceRs: number;
  description: string;
  inStock: boolean;
}

const PRODUCTS: Product[] = [
  {
    name: 'Kevi Noir',
    priceRs: 3500,
    description: 'A bold, woody-oud fragrance with hints of amber. Long-lasting, best for evening wear.',
    inStock: true,
  },
  {
    name: 'Kevi Blanc',
    priceRs: 2800,
    description: 'A light, fresh floral scent with notes of jasmine and citrus. Perfect for daily wear.',
    inStock: true,
  },
  {
    name: 'Kevi Musk Royale',
    priceRs: 4200,
    description: 'A rich musk fragrance with a warm, luxurious finish. Our signature best-seller.',
    inStock: true,
  },
  {
    name: 'Kevi Rose Attar',
    priceRs: 2200,
    description: 'A traditional rose-based attar, alcohol-free, ideal for a subtle everyday scent.',
    inStock: false,
  },
];

// ---------------------------------------------------------------------------
// ORDERS (in-memory for now - resets if the server restarts)
// ---------------------------------------------------------------------------
interface Order {
  id: number;
  customerWhatsApp: string;
  customerName: string;
  productName: string;
  quantity: number;
  totalRs: number;
  createdAt: string;
}

const ORDERS: Order[] = [];
let nextOrderId = 1;

// ---------------------------------------------------------------------------
// TOOL FUNCTIONS
// ---------------------------------------------------------------------------
function calculator(expression: string): string {
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expression})`)();
    return String(result);
  } catch (e) {
    return `Error: ${e}`;
  }
}

async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    const data: any = await res.json();
    if (data.AbstractText) return `${data.AbstractText} (Source: ${data.AbstractSource || 'DuckDuckGo'})`;
    if (data.RelatedTopics?.length > 0 && data.RelatedTopics[0].Text) return data.RelatedTopics[0].Text;
    return `No direct answer found for "${query}".`;
  } catch (e) {
    return `Search failed: ${e}`;
  }
}

function listProducts(): string {
  const lines = PRODUCTS.map(
    (p) =>
      `• *${p.name}* - Rs. ${p.priceRs}${p.inStock ? '' : ' (currently out of stock)'}\n  ${p.description}`
  );
  return `Here's our current ${BUSINESS_NAME} catalog:\n\n${lines.join('\n\n')}`;
}

async function placeOrder(
  customerWhatsApp: string,
  customerName: string,
  productName: string,
  quantity: number
): Promise<string> {
  const product = PRODUCTS.find((p) => p.name.toLowerCase() === productName.toLowerCase());

  if (!product) {
    const names = PRODUCTS.map((p) => p.name).join(', ');
    return `Sorry, we couldn't find "${productName}" in our catalog. Available products: ${names}`;
  }
  if (!product.inStock) {
    return `Sorry, "${product.name}" is currently out of stock.`;
  }
  if (quantity < 1) {
    return `Please specify a valid quantity (1 or more).`;
  }

  const total = product.priceRs * quantity;
  const order: Order = {
    id: nextOrderId++,
    customerWhatsApp,
    customerName,
    productName: product.name,
    quantity,
    totalRs: total,
    createdAt: new Date().toISOString(),
  };
  ORDERS.push(order);

  // Owner ko turant WhatsApp par notify karein
  const ownerMessage =
    `🛍️ New order at ${BUSINESS_NAME}!\n\n` +
    `Order #${order.id}\n` +
    `Customer: ${customerName} (${customerWhatsApp})\n` +
    `Product: ${product.name} x${quantity}\n` +
    `Total: Rs. ${total}`;
  await sendWhatsAppMessage(OWNER_WHATSAPP_NUMBER, ownerMessage);

  return `Order confirmed! ✅\n\nOrder #${order.id}\n${product.name} x${quantity}\nTotal: Rs. ${total}\n\nWe'll be in touch shortly to confirm delivery details. Thank you for shopping with ${BUSINESS_NAME}!`;
}

const AVAILABLE_TOOLS: Record<string, (input: any) => string | Promise<string>> = {
  calculator: (input) => calculator(input.expression),
  web_search: (input) => webSearch(input.query),
  list_products: () => listProducts(),
  place_order: (input) =>
    placeOrder(input.customerWhatsApp, input.customerName, input.productName, input.quantity),
};

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS
// ---------------------------------------------------------------------------
const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluates a math expression. Useful for computing totals or discounts.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Searches the web for a general fact or piece of information not related to our product catalog.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_products',
      description: 'Returns the full perfume catalog with names, prices, and descriptions. Use this whenever a customer asks what products are available, or asks about prices.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_order',
      description: 'Places an order for a customer. Only call this once the customer has confirmed the exact product name, quantity, and given their name.',
      parameters: {
        type: 'object',
        properties: {
          customerWhatsApp: { type: 'string', description: "The customer's WhatsApp number (provided automatically, do not ask for it)" },
          customerName: { type: 'string', description: "The customer's name" },
          productName: { type: 'string', description: 'The exact product name from the catalog' },
          quantity: { type: 'number', description: 'How many units to order' },
        },
        required: ['customerWhatsApp', 'customerName', 'productName', 'quantity'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// AGENT LOOP
// ---------------------------------------------------------------------------
async function runAgent(userMessage: string, customerWhatsApp: string): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        `You are the friendly WhatsApp assistant for "${BUSINESS_NAME}", a perfume shop. ` +
        `Help customers browse the catalog and place orders. Keep replies short and warm, ` +
        `suitable for a chat app. When placing an order, always pass the customer's WhatsApp ` +
        `number as "${customerWhatsApp}" - never ask the customer for it. Always confirm the ` +
        `product name and quantity with the customer before calling place_order.`,
    },
    { role: 'user', content: userMessage },
  ];

  while (true) {
    const response = await groqClient.chat.completions.create({
      model: MODEL,
      max_tokens: 512,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const choice = response.choices[0].message;
    messages.push(choice as ChatCompletionMessageParam);

    const toolCalls = choice.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return choice.content ?? "Sorry, I couldn't come up with a reply.";
    }

    for (const call of toolCalls) {
      const toolName = call.function.name;
      const toolInput = JSON.parse(call.function.arguments);
      const functionToCall = AVAILABLE_TOOLS[toolName];
      const result = await functionToCall(toolInput);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SEND A WHATSAPP MESSAGE
// ---------------------------------------------------------------------------
async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    console.error('Failed to send WhatsApp message:', await res.text());
  }
}

// ---------------------------------------------------------------------------
// WEBHOOK VERIFICATION
// ---------------------------------------------------------------------------
app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------------------------
// WEBHOOK - INCOMING MESSAGES
// ---------------------------------------------------------------------------
app.post('/webhook', async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = message.text?.body;

    if (!text) return;

    console.log(`Incoming from ${from}: ${text}`);

    const reply = await runAgent(text, from);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('Error handling webhook:', err);
  }
});

// ---------------------------------------------------------------------------
// Misc routes
// ---------------------------------------------------------------------------
app.get('/', (_req: Request, res: Response) => {
  res.send(`${BUSINESS_NAME} WhatsApp bot is running.`);
});

app.get('/privacy', (_req: Request, res: Response) => {
  res.send(`
    <html>
      <head><title>Privacy Policy</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.6;">
        <h1>Privacy Policy</h1>
        <p>This WhatsApp bot is operated by ${BUSINESS_NAME}.</p>
        <p>Messages you send are processed to answer product questions and place
        orders. Order details (name, WhatsApp number, product, quantity) are
        stored to fulfil your order and are not shared with third parties beyond
        what is required to process the message (the AI provider used to
        generate responses).</p>
        <p>If you have questions about this bot, please contact the business directly.</p>
      </body>
    </html>
  `);
});

// Simple endpoint to check current orders (useful for the owner)
app.get('/orders', (_req: Request, res: Response) => {
  res.json(ORDERS);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${BUSINESS_NAME} server listening on port ${PORT}`);
});
