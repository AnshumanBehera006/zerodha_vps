require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const { HoldingsModel } = require("./model/HoldingsModel");
const { PositionsModel } = require("./model/PositionsModel");
const { OdersModel } = require("./model/OdersModel");

// Auth imports
const {
  signup,
  login,
  logout,
  signupValidation,
  loginValidation,
} = require("./controllers/AuthController");
const { userVerification, requireAuth } = require("./middlewares/AuthMiddleware");

const PORT = process.env.PORT || 3002;
const url = process.env.MONGO_URL;

const app = express();

// Render (and most hosts) put one reverse proxy in front of the app.
// Trust exactly that one hop so req.ip is the real client IP and
// express-rate-limit can tell users apart. Don't use `true` — that lets
// anyone spoof their IP via a fake X-Forwarded-For header.
app.set("trust proxy", 1);

// ─── Security & Middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cookieParser());
app.use(express.json());
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      process.env.DASHBOARD_URL || "http://localhost:3001",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

// Rate limiter for auth routes — 10 requests per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ─── Auth Routes ────────────────────────────────────────────────────────
app.post("/signup", authLimiter, signupValidation, signup);
app.post("/login", authLimiter, loginValidation, login);
app.post("/logout", logout);
app.post("/verify", userVerification);

// ─── Protected Trading Routes ───────────────────────────────────────────

// Holdings
app.get("/allHoldings", requireAuth, async (req, res) => {
  try {
    const allHoldings = await HoldingsModel.find({ userId: req.user._id });
    res.json(allHoldings);
  } catch (error) {
    console.error("Error fetching holdings:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// Positions
app.get("/allPositions", requireAuth, async (req, res) => {
  try {
    const allPositions = await PositionsModel.find({ userId: req.user._id });
    res.json(allPositions);
  } catch (error) {
    console.error("Error fetching positions:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// New BUY Order
app.post("/newOrder", requireAuth, async (req, res) => {
  try {
    const { name, qty, price, mode } = req.body;
    const orderQty = Number(qty);
    const orderPrice = Number(price);

    const newOrder = new OdersModel({
      name,
      qty: orderQty,
      price: orderPrice,
      mode: mode || "BUY",
      status: "EXECUTED",
      userId: req.user._id,
    });

    await newOrder.save();

    // If BUY order, update or create holding for user
    if ((mode || "BUY").toUpperCase() === "BUY") {
      let holding = await HoldingsModel.findOne({ name, userId: req.user._id });
      if (holding) {
        const totalQty = holding.qty + orderQty;
        const totalCost = holding.avg * holding.qty + orderPrice * orderQty;
        holding.avg = Number((totalCost / totalQty).toFixed(2));
        holding.qty = totalQty;
        holding.price = orderPrice;
        await holding.save();
      } else {
        await HoldingsModel.create({
          name,
          qty: orderQty,
          avg: orderPrice,
          price: orderPrice,
          net: "+0.00%",
          day: "+0.00%",
          userId: req.user._id,
        });
      }
    }

    res.status(201).json({ success: true, message: "Order created successfully" });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ─── SELL Order (CREATE) ────────────────────────────────────────────────
app.post("/sellOrder", requireAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { name, qty, price } = req.body;

    // Validate input
    if (!name || !qty || !price) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Name, quantity, and price are required" });
    }
    if (qty <= 0 || price <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Quantity and price must be greater than 0" });
    }

    // Check user's holding for this stock
    const holding = await HoldingsModel.findOne({
      name: name,
      userId: req.user._id,
    }).session(session);

    if (!holding) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Insufficient quantity to sell" });
    }

    if (holding.qty < qty) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Insufficient quantity to sell. Available: ${holding.qty}`,
      });
    }

    // Create the sell order
    const sellOrder = new OdersModel({
      name,
      qty,
      price,
      mode: "SELL",
      status: "OPEN",
      userId: req.user._id,
    });
    await sellOrder.save({ session });

    // Update the holding
    const newQty = holding.qty - qty;
    if (newQty === 0) {
      await HoldingsModel.deleteOne({ _id: holding._id }).session(session);
    } else {
      holding.qty = newQty;
      await holding.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      success: true,
      message: "Sell order placed successfully",
      order: sellOrder,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error creating sell order:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ─── Orders (READ) ─────────────────────────────────────────────────────
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const filter = { userId: req.user._id };
    if (req.query.mode) {
      filter.mode = req.query.mode.toUpperCase();
    }
    const orders = await OdersModel.find(filter).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.get("/orders/:id", requireAuth, async (req, res) => {
  try {
    const order = await OdersModel.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    res.json(order);
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ─── Orders (UPDATE) — only OPEN orders ─────────────────────────────────
app.put("/orders/:id", requireAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const order = await OdersModel.findById(req.params.id).session(session);
    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.userId.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (order.status !== "OPEN") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Only OPEN orders can be edited" });
    }

    const { qty, price } = req.body;
    if (qty !== undefined && qty <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Quantity must be greater than 0" });
    }
    if (price !== undefined && price <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Price must be greater than 0" });
    }

    // For SELL orders, re-check holding quantity if qty is being changed
    if (order.mode === "SELL" && qty !== undefined && qty !== order.qty) {
      const qtyDiff = qty - order.qty; // positive = selling more, negative = selling less

      if (qtyDiff > 0) {
        // Selling more — check if enough holding is available
        const holding = await HoldingsModel.findOne({
          name: order.name,
          userId: req.user._id,
        }).session(session);

        if (!holding || holding.qty < qtyDiff) {
          await session.abortTransaction();
          session.endSession();
          const available = holding ? holding.qty : 0;
          return res.status(400).json({
            success: false,
            message: `Insufficient quantity. Available: ${available}`,
          });
        }

        // Reduce holding by the difference
        holding.qty -= qtyDiff;
        if (holding.qty === 0) {
          await HoldingsModel.deleteOne({ _id: holding._id }).session(session);
        } else {
          await holding.save({ session });
        }
      } else if (qtyDiff < 0) {
        // Selling less — give back the difference to the holding
        const holding = await HoldingsModel.findOne({
          name: order.name,
          userId: req.user._id,
        }).session(session);

        if (holding) {
          holding.qty += Math.abs(qtyDiff);
          await holding.save({ session });
        } else {
          // Holding was deleted (sold all), recreate it
          await HoldingsModel.create(
            [
              {
                name: order.name,
                qty: Math.abs(qtyDiff),
                avg: order.price,
                price: order.price,
                net: "0.00%",
                day: "0.00%",
                userId: req.user._id,
              },
            ],
            { session }
          );
        }
      }

      order.qty = qty;
    }

    if (price !== undefined) {
      order.price = price;
    }

    await order.save({ session });
    await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      message: "Order updated successfully",
      order,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error updating order:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ─── Orders (DELETE / CANCEL) — only OPEN orders ────────────────────────
app.delete("/orders/:id", requireAuth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const order = await OdersModel.findById(req.params.id).session(session);
    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.userId.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (order.status !== "OPEN") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Only OPEN orders can be cancelled" });
    }

    // For SELL orders, give the quantity back to the holding
    if (order.mode === "SELL") {
      const holding = await HoldingsModel.findOne({
        name: order.name,
        userId: req.user._id,
      }).session(session);

      if (holding) {
        holding.qty += order.qty;
        await holding.save({ session });
      } else {
        // Holding was deleted (sold all), recreate it
        await HoldingsModel.create(
          [
            {
              name: order.name,
              qty: order.qty,
              avg: order.price,
              price: order.price,
              net: "0.00%",
              day: "0.00%",
              userId: req.user._id,
            },
          ],
          { session }
        );
      }
    }

    order.status = "CANCELLED";
    await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      message: "Order cancelled successfully",
      order,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error cancelling order:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ─── Seed routes (commented out — kept for reference) ───────────────────
/* ------------------- HOLDINGS SEED (COMMENTED OUT) -------------------
app.get("/addHoldings", async (req, res) => {
  // ... original seed data ...
  res.send("Holdings added successfully");
});
---------------------------------------------------------------------- */

/* ------------------- POSITIONS SEED (COMMENTED OUT) -------------------
app.get("/addPositions", async (req, res) => {
  // ... original seed data ...
  res.send("Positions added successfully");
});
---------------------------------------------------------------------- */

// ─── Start Server ───────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`App started on port ${PORT}`);
  try {
    await mongoose.connect(url);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
});