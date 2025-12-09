"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
//import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

// Create Transaction
export async function createTransaction(data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    // Get request data for ArcJet
    const req = await request();

    // Check rate limit
    const decision = await aj.protect(req, {
      userId,
      requested: 1, // Specify how many tokens to consume
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });

        throw new Error("Too many requests. Please try again later.");
      }

      throw new Error("Request blocked");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const account = await db.account.findUnique({
      where: {
        id: data.accountId,
        userId: user.id,
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    // Calculate new balance
    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;

    // Create transaction and update account balance
    const transaction = await db.$transaction(async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          ...data,
          userId: user.id,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: newBalance },
      });

      return newTransaction;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getTransaction(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findUnique({
    where: {
      id,
      userId: user.id,
    },
  });

  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Get original transaction to calculate balance change
    const originalTransaction = await db.transaction.findUnique({
      where: {
        id,
        userId: user.id,
      },
      include: {
        account: true,
      },
    });

    if (!originalTransaction) throw new Error("Transaction not found");

    // Calculate balance changes
    const oldBalanceChange =
      originalTransaction.type === "EXPENSE"
        ? -originalTransaction.amount.toNumber()
        : originalTransaction.amount.toNumber();

    const newBalanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netBalanceChange = newBalanceChange - oldBalanceChange;

    // Update transaction and account balance in a transaction
    const transaction = await db.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: {
          id,
          userId: user.id,
        },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      // Update account balance
      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: netBalanceChange,
          },
        },
      });

      return updated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Get User Transactions
export async function getUserTransactions(query = {}) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const transactions = await db.transaction.findMany({
      where: {
        userId: user.id,
        ...query,
      },
      include: {
        account: true,
      },
      orderBy: {
        date: "desc",
      },
    });

    return { success: true, data: transactions };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Scan Receipt
// export async function scanReceipt(formData) {
//   try {
//     const file = formData.get("file");
//     if (!file) throw new Error("No file received");

//     const bytes = await file.arrayBuffer();
//     const base64 = Buffer.from(bytes).toString("base64");

//     const model = genAI.getGenerativeModel({
//       model: "gemini-1.5-flash-latest", // WORKING MODEL
//     });

//     const prompt = `
//       Extract this receipt into JSON:
//       {
//         "amount": number,
//         "date": "ISO string",
//         "description": "string",
//         "merchantName": "string",
//         "category": "string"
//       }
//     `;

//     const result = await model.generateContent([
//       {
//         inlineData: {
//           data: base64,
//           mimeType: file.type,
//         },
//       },
//       prompt,
//     ]);

//     const text = result.response.text().trim();
//     const cleaned = text.replace(/```json|```/g, "").trim();

//     return JSON.parse(cleaned);

//   } catch (err) {
//     console.error("SCAN ERROR:", err.message);
//     throw new Error(`Failed to scan receipt ${err.message}`);
//   }
// }

// export async function scanReceipt(formData) {
//   try {
//     const file = formData.get("file");
//     if (!file) throw new Error("No file received");

//     const bytes = await file.arrayBuffer();
//     const base64 = Buffer.from(bytes).toString("base64");

//     const model = genAI.getGenerativeModel({
//       model: "gemini-1.5-flash",  // FIXED ✔
//     });

//     const prompt = `
//       Extract this receipt into JSON:
//       {
//         "amount": number,
//         "date": "ISO string",
//         "description": "string",
//         "merchantName": "string",
//         "category": "string"
//       }
//     `;

//     const result = await model.generateContent([
//       {
//         inlineData: {
//           data: base64,
//           mimeType: file.type,
//         },
//       },
//       prompt,
//     ]);

//     const text = result.response.text().trim();
//     const cleaned = text.replace(/```json|```/g, "").trim();

//     return JSON.parse(cleaned);

//   } catch (err) {
//     console.error("SCAN ERROR:", err.message);
//     throw new Error(`Failed to scan receipt — ${err.message}`);
//   }
// }
// export async function scanReceipt(formData) {
// try {
//     const file = formData.get("file");
//     if (!file) throw new Error("No file received");

//     const bytes = await file.arrayBuffer();
//     const base64 = Buffer.from(bytes).toString("base64");

//     const model = genAI.getGenerativeModel({
//       model: "models/gemini-2.5-flash",
//     });

//     const prompt = `
// You are a receipt-reading AI. Extract fields ONLY in valid JSON.

// Valid categories:
// ["housing","transportation","groceries","utilities","entertainment","food","shopping","healthcare","education","personal","travel","insurance","gifts","bills","other-expense"]

// Choose the BEST matching category from the list above.
// If unsure, choose "other-expense".

// Return ONLY JSON in this exact format:

// {
//   "amount": number,
//   "date": "ISO string",
//   "description": "string",
//   "merchantName": "string",
//   "category": "string"
// }
// `;
//     const result = await model.generateContent([
//       {
//         inlineData: {
//           data: base64,
//           mimeType: file.type,
//         },
//       },
//       prompt,
//     ]);

//     const text = result.response.text().trim();
//     const cleaned = text.replace(/```json|```/g, "").trim();

//     return JSON.parse(cleaned);

//   } catch (err) {
//     console.error("SCAN ERROR:", err.message);
//     throw new Error(`Failed to scan receipt — ${err.message}`);
//   }
// }

// Scan Receipt (FINAL STABLE VERSION)
export async function scanReceipt(formData) {
  try {
    const file = formData.get("file");
    if (!file) throw new Error("No file received");

    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");

    // Gemini 2.5 Flash — confirmed available in your API list
    const model = genAI.getGenerativeModel({
      model: "models/gemini-2.5-flash",
    });

    const allowedCategories = [
      "housing","transportation","groceries","utilities","entertainment",
      "food","shopping","healthcare","education","personal","travel",
      "insurance","gifts","bills","other-expense"
    ];

    const prompt = `You are an expert receipt parser. Extract fields ONLY in valid JSON.VALID CATEGORIES:${JSON.stringify(allowedCategories)}

        RULES:
        - Pick the best matching category from the list.
        - If unsure, ALWAYS choose "other-expense".
        - Do NOT invent new category names.
        - Respond ONLY in pure JSON. No explanation.

        RETURN JSON IN THIS EXACT FORMAT:
        {
          "amount": number,
          "date": "ISO string",
          "description": "string",
          "merchantName": "string",
          "category": "string"
        }
        `;

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64,
          mimeType: file.type,
        },
      },
      prompt
    ]);

    let text = result.response.text().trim();

    // Remove ```json ... ```
    text = text.replace(/```json|```/g, "").trim();

    let data = JSON.parse(text);

    // CATEGORY FIX → ENSURE one of allowed list
    if (!allowedCategories.includes(data.category)) {
      data.category = "other-expense";
    }

    return {
      amount: Number(data.amount) || 0,
      date: new Date(data.date),
      description: data.description || "",
      merchantName: data.merchantName || "",
      category: data.category,

    };

  } catch (err) {
    console.error("SCAN ERROR:", err.message);
    throw new Error(`Failed to scan receipt — ${err.message}`);
  }
}


// Helper function to calculate next recurring date
function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  switch (interval) {
    case "DAILY":
      date.setDate(date.getDate() + 1);
      break;
    case "WEEKLY":
      date.setDate(date.getDate() + 7);
      break;
    case "MONTHLY":
      date.setMonth(date.getMonth() + 1);
      break;
    case "YEARLY":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }

  return date;
}