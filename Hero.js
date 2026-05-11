"use client";
import { motion } from "framer-motion";

export default function Hero() {
  return (
    <div className="bg-gradient-to-r from-blue-700 to-indigo-700 text-white p-20 text-center">
      <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        🔴 Live Buyer Activity
      </motion.p>
      <motion.h1 initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} className="text-4xl font-bold mt-4">
        Find Verified Suppliers Instantly
      </motion.h1>
      <motion.input initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="mt-6 p-4 w-96 rounded text-black" placeholder="Search products..." />
    </div>
  );
}