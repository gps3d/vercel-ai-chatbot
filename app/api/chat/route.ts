import 'server-only'
import OpenAI from 'openai'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { Database } from '@/lib/db_types'
import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(req: Request) {
  try {
    console.log('Chat API: Starting request processing')

    const cookieStore = cookies()
    const supabase = createRouteHandlerClient<Database>({
      cookies: () => cookieStore
    })

    const json = await req.json()
    const { messages, threadId } = json
    
    try {
      console.log('Chat API: Checking authentication')
      const session = await auth({ cookieStore })
      if (!session?.user?.id) {
        console.log('Chat API: No user session found')
        return new Response('Unauthorized', {
          status: 401
        })
      }
      const userId = session.user.id

      if (!process.env.OPENAI_ASSISTANT_ID) {
        return new Response('OpenAI Assistant ID not configured', {
          status: 500
        })
      }

      // Create or retrieve thread
      const thread = threadId 
        ? await openai.beta.threads.retrieve(threadId)
        : await openai.beta.threads.create()

      // Add the new message to thread
      await openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: messages[messages.length - 1].content
      })

      // Run the assistant
      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID
      })

      // Poll for completion
      let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id)
      while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id)
      }

      if (runStatus.status === 'completed') {
        // Get messages after run completion
        const messagesList = await openai.beta.threads.messages.list(thread.id)
        const lastMessage = messagesList.data[0]

        // Save to database
        const chatId = json.id ?? nanoid()
        const title = messages[0].content.substring(0, 100)
        const createdAt = Date.now()
        const path = `/chat/${chatId}`

        const chatData = {
          id: chatId,
          user_id: userId,
          payload: {
            title,
            createdAt,
            path,
            threadId: thread.id,
            messages: [
              ...messages,
              {
                role: 'assistant',
                content: lastMessage.content[0].text.value
              }
            ]
          }
        }

        await supabase
          .from('chats')
          .upsert(chatData)
          .throwOnError()

        return new Response(JSON.stringify({
          role: 'assistant',
          content: lastMessage.content[0].text.value,
          threadId: thread.id
        }))
      } else {
        return new Response('Assistant run failed', { status: 500 })
      }
    } catch (authError) {
      console.error('Chat API: Authentication error:', authError)
      return new Response(
        JSON.stringify({ error: 'Authentication failed', details: authError }), 
        { status: 401 }
      )
    }
  } catch (error) {
    console.error('Chat API: Unexpected error:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Internal Server Error', 
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error
      }), 
      { 
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    )
  }
}
