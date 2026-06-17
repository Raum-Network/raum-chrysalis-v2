# Raydium Adapter

Anchor adapter for executing vetted Raydium CPMM/CP-Swap instructions from Chrysalis V2 intents.

The adapter validates the configured Raydium program id and the Anchor instruction discriminator before forwarding CPI. The API resolves pool/vault/account state and serialized instruction data using Raydium SDK tooling.

Main instruction:

```text
execute(intent_id, action, amount_in, limit_amount, cpi_data, memo)
```

Receipt PDA:

```text
["raydium-receipt", intent_id]
```
