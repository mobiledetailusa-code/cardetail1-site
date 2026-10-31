# Recibo administrativo no drawer

O botão "Report Square observation" envia `close_manual_collection` com `payment_reported`. Isso não grava `LedgerEntry`, não altera o saldo e não marca a reserva como paga.

O botão "Record Dashboard receipt" envia `record_square_dashboard_receipt` com a referência Square, o valor em centavos que o administrador leu no Dashboard, a moeda, o booking e o operation id da coleta. O servidor compara o valor com o saldo. A tela não decide o ledger, o saldo nem o status de pagamento.

As duas ações dizem que a Cardetail1 não consultou a Square. Uma resposta incerta atualiza o booking a partir do servidor e não reenvia o recibo sozinha.

"Finalize receipt reconciliation" só aparece quando a visão do servidor tem estado `payment_reported`, um recibo gravado, saldo restante zero e nenhum conflito. O clique envia `close_manual_collection` com `receipt_reconciled` e as quatro confirmações, inclusive a declaração de que o administrador desativou o link no Dashboard. A Cardetail1 não desativa o link e não marca `squareVerified`.
