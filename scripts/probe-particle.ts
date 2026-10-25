import 'dotenv/config';

const main = async () => {
  const res = await fetch(`${process.env.PARTICLE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.PARTICLE_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.PARTICLE_MODEL,
      messages: [
        { role: 'system', content: 'Reply with strict JSON only.' },
        { role: 'user', content: 'Return {"ok":true,"reason":"probe"} and nothing else.' },
      ],
      max_tokens: 300,
      temperature: 0.2,
    }),
  });
  console.log('status', res.status);
  const text = await res.text();
  console.log(text.slice(0, 800));
};

main();
