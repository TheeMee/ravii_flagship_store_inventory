/**
 * =================================================================================
 * --- 📦 TRANSFER CHECKER: Contextual Inventory Insights (v3)
 * =================================================================================
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🦄 Tools')
    .addItem('🔍 Analyze Transfer List', 'analyzeTransferList')
    .addToUi();
}

function analyzeTransferList() {
  const ui = SpreadsheetApp.getUi();
  
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tcSheet = ss.getSheetByName("TC");
    const invSheet = ss.getSheetByName("Inventory");
    
    // --- Error Handling: Check if tabs exist ---
    if (!tcSheet) {
      ui.alert("❌ Missing Tab", "Could not find the tab named 'TC'. Please check the spelling or create the tab.", ui.ButtonSet.OK);
      return;
    }
    if (!invSheet) {
      ui.alert("❌ Missing Tab", "Could not find the tab named 'Inventory'. Please check the spelling or create the tab.", ui.ButtonSet.OK);
      return;
    }

    // 🧹 NEW: Completely wipe the Comments column (Column E) before starting
    tcSheet.getRange("E2:E").clearContent();
    
    // --- 1. Map the Inventory Data ---
    const invData = invSheet.getDataRange().getValues();
    const inventory = {}; 
    const itemsByName = {};
    
    // Start loop at 1 to skip the header row
    for (let i = 1; i < invData.length; i++) {
      const sku = invData[i][0] ? invData[i][0].toString().trim() : "";
      
      const color = invData[i][3] ? invData[i][3].toString().trim() : ""; // Col D 'color'
      const size = invData[i][4] ? invData[i][4].toString().trim() : "";  // Col E 'size'
      const name = invData[i][5] ? invData[i][5].toString().trim() : "";  // Col F 'Name'
      const stock = Number(invData[i][9]) || 0;                           // Col J 'HQ Inventory'
      
      if (!sku) continue;
      
      inventory[sku] = { name: name, color: color, size: size, stock: stock };
      
      if (!itemsByName[name]) {
        itemsByName[name] = [];
      }
      itemsByName[name].push({ sku: sku, color: color, size: size, stock: stock });
    }
    
    // --- 2. Evaluate the TC List ---
    const lastRow = tcSheet.getLastRow();
    
    if (lastRow < 2) {
      ui.alert("ℹ️ Empty List", "There are no SKUs in the TC tab to analyze.", ui.ButtonSet.OK);
      return;
    }
    
    const tcRange = tcSheet.getRange(2, 1, lastRow - 1, 5); // Columns A through E
    const tcData = tcRange.getValues();
    const commentsOutput = [];
    
    for (let i = 0; i < tcData.length; i++) {
      const row = tcData[i];
      const targetSku = row[1] ? row[1].toString().trim() : "";
      let rowComments = [];
      
      if (!targetSku) {
        commentsOutput.push([""]); 
        continue;
      }
      
      const itemDef = inventory[targetSku];
      
      if (!itemDef) {
        rowComments.push("⚠️ SKU not found in Inventory tab");
      } else {
        
        // Condition A: Is this EXACT SKU already in stock?
        if (itemDef.stock > 0) {
          rowComments.push(`🚨 Already in stock (${itemDef.stock} pcs)`);
        }
        
        let relatedItems = itemsByName[itemDef.name] || [];
        let otherVariationsStock = 0;
        let sameSizeDiffColorStock = 0;
        
        relatedItems.forEach(rel => {
          if (rel.sku !== targetSku && rel.stock > 0) {
            otherVariationsStock += rel.stock;
            
            // Condition C: Same size, different color
            if (rel.size === itemDef.size) {
              sameSizeDiffColorStock += rel.stock;
            }
          }
        });
        
        // Condition B: Total pieces of this item (other variations)
        if (otherVariationsStock > 0) {
          rowComments.push(`📦 Other SKUs of '${itemDef.name}' in stock: ${otherVariationsStock} pcs`);
        }
        
        if (sameSizeDiffColorStock > 0) {
          rowComments.push(`🎨 Size ${itemDef.size} available in other colors: ${sameSizeDiffColorStock} pcs`);
        }
      }
      
      if (rowComments.length === 0) {
        rowComments.push("✅ Clear to send");
      }
      
      commentsOutput.push([rowComments.join(" | ")]);
    }
    
    // --- 3. Write Comments Back to TC ---
    tcSheet.getRange(2, 5, commentsOutput.length, 1).setValues(commentsOutput);
    
  } catch (error) {
    ui.alert("❌ Execution Error", "Something went wrong while running the script:\n\n" + error.message, ui.ButtonSet.OK);
  }
}