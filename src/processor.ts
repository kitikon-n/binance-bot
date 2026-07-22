import { supabase } from "./supabase.js";
import {
  actionToOrder,
  getPositions,
  placeFuturesOrder,
} from "./binance.js";
import { getTrends, checkTrendRule } from "./trend.js";

export async function processSignal(payload: any): Promise<void> {
  const { strategy, secret, action, symbol, use_trend_filter = true } = payload;
  let signalRowId: string | undefined;

  try {
    // 1) Insert signal
    const { data: signalRow, error: insertErr } = await supabase
      .from("signals")
      .insert({
        strategy_name: strategy,
        symbol,
        action,
        raw_payload: payload,
      })
      .select()
      .single();

    if (insertErr || !signalRow) {
      console.error("[processSignal] Failed to insert signal:", insertErr);
      return;
    }

    signalRowId = signalRow.id;

    // 2) ดึง strategy + verify
    const { data: strat, error } = await supabase
      .from("strategies")
      .select("*")
      .eq("name", strategy)
      .single();

    if (error || !strat) throw new Error("Strategy not found");
    if (!strat.enabled) throw new Error("Strategy disabled");
    if (strat.webhook_secret !== secret) throw new Error("Invalid secret");
    if (strat.symbol !== symbol) throw new Error("Symbol mismatch");

    const { side, positionSide } = actionToOrder(action);

    // 3) เช็ค trend filter
    const { trend: currentTrend, small_trend: currentSmallTrend } = await getTrends(symbol);

    let trendCheck: { allowed: boolean; reason?: string };
    if (!use_trend_filter || action === "close_long" || action === "close_short") {
      trendCheck = { allowed: true };
    } else if (action === "open_long") {
      const allowed = currentTrend === "UP" && currentSmallTrend === "UP";
      trendCheck = allowed
        ? { allowed: true }
        : { allowed: false, reason: `open_long requires trend=UP and small_trend=UP, got trend=${currentTrend} small_trend=${currentSmallTrend}` };
    } else if (action === "open_short") {
      const allowed = currentTrend === "DOWN" && currentSmallTrend === "DOWN";
      trendCheck = allowed
        ? { allowed: true }
        : { allowed: false, reason: `open_short requires trend=DOWN and small_trend=DOWN, got trend=${currentTrend} small_trend=${currentSmallTrend}` };
    } else {
      trendCheck = checkTrendRule(action, currentTrend);
    }

    if (!trendCheck.allowed) {
      await supabase.from("trades").insert({
        signal_id: signalRowId,
        strategy_name: strategy,
        symbol,
        side,
        position_side: positionSide,
        status: "blocked",
        binance_response: {
          reason: trendCheck.reason,
          current_trend: currentTrend,
          current_small_trend: currentSmallTrend,
        },
      });
      await supabase
        .from("signals")
        .update({ processed: true, error: trendCheck.reason })
        .eq("id", signalRowId);
      console.log(`[processSignal] Blocked: ${trendCheck.reason}`);
      return;
    }

    // 4) เช็ค position ก่อนปิด
    const isCloseAction = action === "close_long" || action === "close_short";
    let quantityToUse = strat.fixed_quantity;

    if (isCloseAction) {
      const { longAmt, shortAmt } = await getPositions(symbol);
      const currentAmt = action === "close_long" ? longAmt : shortAmt;

      if (currentAmt === 0) {
        await supabase.from("trades").insert({
          signal_id: signalRowId,
          strategy_name: strategy,
          symbol,
          side,
          position_side: positionSide,
          status: "skipped",
          binance_response: {
            reason: `No ${positionSide} position to close`,
            longAmt,
            shortAmt,
          },
        });
        await supabase
          .from("signals")
          .update({ processed: true })
          .eq("id", signalRowId);
        console.log(
          `[processSignal] Skipped: No ${positionSide} position to close`
        );
        return;
      }

      quantityToUse = currentAmt;
    }

    // 5) ส่งคำสั่ง
    // ตอนปิด: ใช้ closePosition=true ให้ Binance ปิดทั้งฝั่งเอง
    // (ห้ามส่ง quantity คู่กับ closePosition — Binance จะ reject)
    const order = await placeFuturesOrder(
      isCloseAction
        ? {
            symbol,
            side,
            positionSide,
            type: "MARKET",
            closePosition: "true",
          }
        : {
            symbol,
            side,
            positionSide,
            type: "MARKET",
            quantity: quantityToUse,
          }
    );

    // 6) บันทึก success
    await supabase.from("trades").insert({
      signal_id: signalRowId,
      strategy_name: strategy,
      symbol,
      side,
      position_side: positionSide,
      quantity: quantityToUse,
      binance_order_id: order.orderId,
      status: "success",
      binance_response: {
        ...order,
        trend_at_execution: currentTrend,
        small_trend_at_execution: currentSmallTrend,
        ...(isCloseAction
          ? { close_mode: "closePosition", position_amt_at_signal: quantityToUse }
          : {}),
      },
    });

    await supabase
      .from("signals")
      .update({ processed: true })
      .eq("id", signalRowId);

    console.log(
      `[processSignal] Success: ${action} ${symbol} qty=${quantityToUse} orderId=${order.orderId}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processSignal] Error: ${message}`);

    if (signalRowId) {
      await supabase.from("trades").insert({
        signal_id: signalRowId,
        strategy_name: strategy,
        symbol,
        status: "failed",
        binance_response: { error: message },
      });

      await supabase
        .from("signals")
        .update({ processed: true, error: message })
        .eq("id", signalRowId);
    }
  }
}
