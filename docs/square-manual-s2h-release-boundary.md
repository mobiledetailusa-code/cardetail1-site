# Limite de liberação da coleta manual Square

A flag de servidor é `MANUAL_SQUARE_COLLECTION_ENABLED`. Só o valor exato `true` liga reservas novas e o registro de uma URL nova. Valor ausente, vazio ou diferente de `true` significa desligado.

Com a flag desligada:

- Uma reserva nova é recusada.
- O registro de uma URL nova é recusado.
- Uma reserva já gravada continua bloqueando liquidação em dinheiro e cartão no local.
- Fechamento administrativo e recibo do Square Dashboard continuam disponíveis para a reserva existente.
- `manualPayLink` legado no Blob não é apagado e não vira reserva.

A flag não torna seguro um build anterior à S2G.1. Esse build não lê `manualCollectionState`. Enquanto existir linha `reserved`, `recorded` ou `payment_reported`, o rollback para esse build fica proibido.

Ordem quando a migração for autorizada:

1. Aplicar `prisma/migrations/20261030220000_manual_collection_booking_s2g1`.
2. Implantar o build cujo Prisma Client inclui essas colunas e cujas travas leem o estado.
3. Manter a flag desligada.
4. Revisar, só em leitura, reservas cujo Blob tem `manualPayLink` e cujo `manualCollectionState` está vazio. Não converter automaticamente.
5. Ligar a flag somente depois dessa revisão.

Build mínimo que preserva a trava: o que contém a coordenação da S2G.1 em diante, incluindo este ramo. Identificar coletas ativas: `manualCollectionState` em `reserved`, `recorded` ou `payment_reported`. Emergência: manter esse build implantado e desligar a flag. Não remover as colunas.
