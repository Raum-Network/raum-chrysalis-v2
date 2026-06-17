# Blend Adapter

Soroban adapter for policy-gated Blend pool and backstop calls.

Main method:

```text
execute(caller, intent_id, action, target, method, args, amount, memo)
```

The adapter validates the configured pool/backstop target and method symbol, invokes Blend with `env.invoke_contract`, and stores a receipt in persistent storage keyed by the Arc intent id.
