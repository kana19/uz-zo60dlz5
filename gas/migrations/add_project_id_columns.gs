/**
 * ウルトラZAIMUくん LEO版 GAS — マイグレーション
 * §3-9-3 PC版4区分構造＋案件粗利機能・サイクルA 基盤データ構造整備
 *
 * 対象：
 *   - 売上シート T列(20) に「案件ID」ヘッダ追加
 *   - コストシート V列(22) に「案件ID」ヘッダ追加
 *   - settingsシート A16 に「featureVisibility」ラベル追加（既存空セル時のみ）
 *   - attendance シート I列(9) に「案件ID」ヘッダ追加（サイクルA・後付け紐付け運用）
 *
 * 手動実行：GASエディタから addProjectIdColumns() を一度だけ実行
 *   既存データはそのまま・ヘッダ行のみ追加されるため安全
 *   既に追加済みの場合はスキップされる（冪等性あり）
 */
function addProjectIdColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- 売上シート T列(20) ヘッダ追加 ---
  var salesSheet = ss.getSheetByName('売上');
  if (salesSheet) {
    var salesLastCol = salesSheet.getLastColumn();
    var salesHeader = salesLastCol >= 20 ? salesSheet.getRange(1, 20).getValue() : '';
    if (salesLastCol < 20 || !salesHeader) {
      salesSheet.getRange(1, 20).setValue('案件ID');
      Logger.log('売上シート T列(20) に「案件ID」ヘッダ追加');
    } else {
      Logger.log('売上シート T列(20) は既に "' + salesHeader + '" が設定済みのためスキップ');
    }
  } else {
    Logger.log('売上シートが存在しないためスキップ（初回入力時に20列で自動作成されます）');
  }

  // --- コストシート V列(22) ヘッダ追加 ---
  var costSheet = ss.getSheetByName('コスト');
  if (costSheet) {
    var costLastCol = costSheet.getLastColumn();
    var costHeader = costLastCol >= 22 ? costSheet.getRange(1, 22).getValue() : '';
    if (costLastCol < 22 || !costHeader) {
      costSheet.getRange(1, 22).setValue('案件ID');
      Logger.log('コストシート V列(22) に「案件ID」ヘッダ追加');
    } else {
      Logger.log('コストシート V列(22) は既に "' + costHeader + '" が設定済みのためスキップ');
    }
  } else {
    Logger.log('コストシートが存在しないためスキップ（初回入力時に22列で自動作成されます）');
  }

  // --- settingsシート A16 ラベル追加 ---
  var settingsSheet = ss.getSheetByName('settings');
  if (settingsSheet) {
    var a16 = settingsSheet.getRange('A16').getValue();
    if (!a16) {
      settingsSheet.getRange('A16').setValue('featureVisibility');
      Logger.log('settingsシート A16 に「featureVisibility」ラベルを追加');
    } else {
      Logger.log('settingsシート A16 は既に "' + a16 + '" が設定済みのためスキップ');
    }
  } else {
    Logger.log('settingsシートが存在しないためスキップ');
  }

  // --- attendance シート I列(9) ヘッダ追加（サイクルA・後付け案件紐付け運用） ---
  // 既存 attendance は v3 形式 8列（…登録日時まで）。9列目に「案件ID」を追加する
  var attendanceSheet = ss.getSheetByName('attendance');
  if (attendanceSheet) {
    var attLastCol = attendanceSheet.getLastColumn();
    var attHeaders = attLastCol >= 1
      ? attendanceSheet.getRange(1, 1, 1, attLastCol).getValues()[0]
      : [];
    if (attHeaders.indexOf('案件ID') === -1) {
      // 既存の最終列+1 に「案件ID」を追加（v3=8列 → 9列化）
      attendanceSheet.getRange(1, attLastCol + 1).setValue('案件ID');
      Logger.log('attendance シートに「案件ID」ヘッダ追加（' + (attLastCol + 1) + '列目）');
    } else {
      Logger.log('attendance シート「案件ID」ヘッダ既に存在・スキップ');
    }
  } else {
    Logger.log('attendance シートが存在しないためスキップ（初回打刻時に9列で自動作成されます）');
  }

  // 取引ペア紐付けモデルでは projects シートは使用しない（旧モデル時代の遺物）
  // 物理削除はユーザー側でスプレッドシート上のタブを右クリック → 削除で実施

  Logger.log('addProjectIdColumns マイグレーション完了');
}
