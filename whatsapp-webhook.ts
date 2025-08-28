// supabase/functions/whatsapp-rag/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
// WhatsApp Configuration
const VERIFY_TOKEN = "{VERIFY_TOKEN}";
const WHATSAPP_API_URL = "https://graph.facebook.com/v20.0";
const WHATSAPP_PHONE_NUMBER_ID = "{WHATSAPP_PHONE_NUMBER_ID}"; 
const WHATSAPP_ACCESS_TOKEN = "{WHATSAPP_ACCESS_TOKEN}";
// RAG Backend Configuration
const RAG_BACKEND_URL = "{RAG_BACKEND_URL}";
// Supabase Configuration
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
serve(async (req)=>{
  const { method, url } = req;
  console.log(`WhatsApp RAG - ${method} request received at ${new Date().toISOString()}`);
  // Debug endpoint for testing
  if (method === "GET") {
    const urlObj = new URL(url);
    const phoneParam = urlObj.searchParams.get("phone");
    if (phoneParam) {
      return new Response(JSON.stringify({
        phone: phoneParam,
        message: `WhatsApp RAG service active for ${phoneParam}`
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // Webhook verification
    const mode = urlObj.searchParams.get("hub.mode");
    const token = urlObj.searchParams.get("hub.verify_token");
    const challenge = urlObj.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully");
      return new Response(challenge, {
        status: 200
      });
    } else {
      console.warn("Webhook verification failed");
      return new Response("Forbidden", {
        status: 403
      });
    }
  }
  // Handle incoming WhatsApp message (POST)
  if (method === "POST") {
    const body = await req.json();
    console.log("Incoming WhatsApp payload:", JSON.stringify(body, null, 2));
    try {
      const entry = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!entry) {
        console.log("No message found in payload");
        return new Response("No message", {
          status: 200
        });
      }
      const from = entry.from;
      const userMessage = entry.text?.body?.trim();
      if (!userMessage) {
        console.log("No text message found, ignoring");
        return new Response("OK", {
          status: 200
        });
      }
      console.log(`Message from ${from}: "${userMessage}"`);
      // Special command to reset (optional)
      if (userMessage.toLowerCase() === 'reset') {
        await sendWhatsAppMessage(from, "Session reset! Ask me anything about our knowledge base.");
        return new Response("Session reset", {
          status: 200
        });
      }
      // Process message with RAG
      const response = await handleRAGQuery(from, userMessage);
      console.log(`RAG response: "${response}"`);
      // Send reply
      await sendWhatsAppMessage(from, response);
      return new Response("Message processed", {
        status: 200
      });
    } catch (error) {
      console.error("Error processing message:", error);
      try {
        const from = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (from) {
          await sendWhatsAppMessage(from, "Sorry, I'm having technical difficulties. Please try again in a moment.");
        }
      } catch (sendError) {
        console.error("Failed to send error message:", sendError);
      }
      return new Response("Error", {
        status: 500
      });
    }
  }
  return new Response("Method not allowed", {
    status: 405
  });
});
async function handleRAGQuery(phoneNumber, message) {
  try {
    // Generate session ID (phone number + date)
    const today = new Date().toISOString().split('T')[0];
    const sessionId = `whatsapp_${phoneNumber}_${today}`;
    console.log(`Processing RAG query for session: ${sessionId}`);
    console.log(`Query: "${message}"`);
    // Call RAG Backend
    const ragResponse = await fetch(`${RAG_BACKEND_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: message,
        session_id: sessionId,
        options: {
          similarity_threshold: 0.6,
          max_results: 3,
          temperature: 0.7,
          max_tokens: 400 // Keep responses shorter for WhatsApp
        }
      })
    });
    console.log("RAG Backend response:", {
      status: ragResponse.status,
      statusText: ragResponse.statusText,
      ok: ragResponse.ok
    });
    if (!ragResponse.ok) {
      const errorText = await ragResponse.text();
      console.error("RAG Backend error:", errorText);
      throw new Error(`RAG Backend error: ${ragResponse.statusText}`);
    }
    const ragData = await ragResponse.json();
    console.log("RAG response data:", {
      success: ragData.success,
      hasResponse: !!ragData.data?.response,
      sourcesCount: ragData.data?.sources?.length || 0,
      contextChunksUsed: ragData.data?.context_chunks_used || 0
    });
    let responseText = ragData.data?.response || "I'm having trouble processing your request right now. Please try again.";
    // Format response for WhatsApp
    responseText = responseText.replace(/\*\*(.*?)\*\*/g, '*$1*') // Bold markdown to WhatsApp format
    .replace(/\*(.*?)\*/g, '_$1_') // Italic markdown to WhatsApp format
    .substring(0, 1500); // WhatsApp message limit
    // Add source information if available
    // if (ragData.data?.sources?.length > 0) {
    //   responseText += `\n\n_Based on ${ragData.data.sources.length} document(s) from our knowledge base_`;
    // }
    // Add helpful footer
    responseText += `\n\nType 'reset' to start a new conversation.`;
    return responseText;
  } catch (error) {
    console.error("Error in RAG query processing:", error);
    return "I'm experiencing technical difficulties. Please try again in a few minutes or contact support.";
  }
}
async function sendWhatsAppMessage(to, message) {
  try {
    console.log(`Sending WhatsApp message to ${to} (${message.length} characters)`);
    const response = await fetch(`${WHATSAPP_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        text: {
          body: message
        }
      })
    });
    const result = await response.json();
    console.log("WhatsApp API response:", {
      status: response.status,
      ok: response.ok,
      messageId: result.messages?.[0]?.id
    });
    if (!response.ok) {
      console.error("WhatsApp API error:", result);
      throw new Error(`WhatsApp API error: ${response.statusText}`);
    }
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    throw error;
  }
}
