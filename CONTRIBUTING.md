# Como contribuir

Obrigado por ajudar com o Bothierry! O fluxo é simples.

## Fluxo

1. Crie uma branch a partir da `main` (`git checkout -b minha-mudanca`).
2. Faça a mudança, pequena e focada em uma coisa só.
3. Rode as mesmas checagens do CI antes de abrir o PR:

   ```sh
   npm ci
   npm run check   # ESLint
   npm test        # node --test
   ```

4. Abra um Pull Request para a `main` explicando o que mudou e por quê.
5. Com o CI verde, o PR é mergeado. A `main` é publicada na VM automaticamente, então nada entra nela sem passar pelo CI.

## Coautoria

Se alguém ajudou de verdade na mudança, dê o crédito no fim da mensagem do commit (ou do squash do PR):

```
Co-authored-by: Nome <email@exemplo.com>
```

## Cuidados

- Nunca envie `.env`, tokens, sessão do WhatsApp nem dados de conversa. Use o `.env.example` como modelo.
- Mudou um comportamento do bot? Atualize o `README.md` e o `changelog.json`.
