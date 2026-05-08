import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy initialize Firebase Admin
let adminDb: admin.firestore.Firestore | null = null;
function getAdminDb() {
  if (!adminDb) {
    if (admin.apps.length === 0) {
      // In Cloud Run, this will auto-initialize if the service account has Firestore roles
      // Or it will use GOOGLE_APPLICATION_CREDENTIALS if set
      admin.initializeApp();
    }
    adminDb = admin.firestore();
    
    // Explicitly set database ID if provided in config
    try {
      const configPath = path.join(process.cwd(), "firebase-applet-config.json");
      if (fs.existsSync(configPath)) {
        const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (firebaseConfig.firestoreDatabaseId) {
          // Note: Standard firebase-admin doesn't easily support databaseId in initializeApp 
          // without settings, but we can try to use it if needed.
          // For now, default database is usually sufficient, or we'd need more complex setup.
        }
      }
    } catch (e) {
      console.warn("Could not load database ID from config, using default.");
    }
  }
  return adminDb;
}

async function startServer() {
  const expressApp = express();
  const PORT = 3000;

  expressApp.use(express.json());

  // --- API ROUTES ---

  expressApp.get("/api/postback", async (req, res) => {
    const { subid, offer_id, payout } = req.query;
    const db = getAdminDb();

    console.log("Postback received:", { subid, offer_id, payout });

    if (!subid || !offer_id) {
      return res.status(400).json({ error: "Missing subid or offer_id" });
    }

    try {
      const userRef = db.collection("users").doc(subid as string);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const payoutAmount = parseFloat(payout as string) || 0;

      // 1. Idempotency Check
      const recentLeads = await db.collection("leads")
        .where("userId", "==", subid)
        .where("offerId", "==", offer_id)
        .where("timestamp", ">", admin.firestore.Timestamp.fromMillis(Date.now() - 1000 * 60 * 5))
        .limit(1)
        .get();
      
      if (!recentLeads.empty) {
        return res.status(409).json({ error: "Duplicate conversion detected" });
      }

      // 2. Atomic Update
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const userData = userDoc.data()!;

        // Update target user
        transaction.update(userRef, {
          "balance": admin.firestore.FieldValue.increment(payoutAmount),
          "stats.leads": admin.firestore.FieldValue.increment(1),
          "updatedAt": admin.firestore.FieldValue.serverTimestamp()
        });

        // Log the Lead
        const leadRef = db.collection("leads").doc();
        transaction.set(leadRef, {
          userId: subid,
          offerId: offer_id,
          payout: payoutAmount,
          ip: req.ip,
          userAgent: req.get("user-agent"),
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // 3. Referral Commission
        if (userData.referredBy) {
          const referrerQuery = await db.collection("users")
            .where("referralCode", "==", userData.referredBy.toUpperCase())
            .limit(1)
            .get();
          
          if (!referrerQuery.empty) {
            const referrerDoc = referrerQuery.docs[0];
            const commission = payoutAmount * 0.1;
            
            if (commission > 0) {
              transaction.update(referrerDoc.ref, {
                "balance": admin.firestore.FieldValue.increment(commission),
                "stats.referralEarnings": admin.firestore.FieldValue.increment(commission),
                "updatedAt": admin.firestore.FieldValue.serverTimestamp()
              });
              
              const commissionRef = db.collection("referral_commissions").doc();
              transaction.set(commissionRef, {
                referrerId: referrerDoc.id,
                refereeId: subid,
                offerId: offer_id,
                amount: commission,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }
        }
      });

      res.json({ status: "success", received: { subid, offerId: offer_id, payout: payoutAmount } });
    } catch (error) {
      console.error("Postback Error:", error);
      res.status(500).json({ status: "error", message: (error as Error).message });
    }
  });

  // --- VITE MIDDLEWARE ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    expressApp.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    expressApp.use(express.static(distPath));
    expressApp.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  expressApp.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
