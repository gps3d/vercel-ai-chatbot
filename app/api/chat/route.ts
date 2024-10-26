import 'server-only'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { Configuration, OpenAIApi } from 'openai-edge'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { Database } from '@/lib/db_types'
import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})

const openai = new OpenAIApi(configuration)

export async function POST(req: Request) {
  try {
    console.log('Chat API: Starting request processing')
    console.log('OpenAI API Key exists:', !!process.env.OPENAI_API_KEY)

    const cookieStore = cookies()
    const supabase = createRouteHandlerClient<Database>({
      cookies: () => cookieStore
    })

    const json = await req.json()
    const { messages, previewToken } = json
    
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
      console.log('Chat API: User authenticated:', userId)

      const apiKey = previewToken || process.env.OPENAI_API_KEY
      if (!apiKey) {
        console.log('Chat API: No API key available')
        return new Response('OpenAI API key not configured', {
          status: 500
        })
      }

      console.log('Chat API: Making OpenAI request')
      const res = await openai.createChatCompletion({
        model: 'o1-mini',
        messages,
        temperature: 0.7,
        stream: true
      })

      if (!res.ok) {
        const errorData = await res.json().catch(() => null)
        console.error('Chat API: OpenAI request failed', errorData)
        return new Response(
          JSON.stringify({ error: 'OpenAI request failed', details: errorData }), 
          { status: res.status }
        )
      }

      const stream = OpenAIStream(res, {
        async onCompletion(completion) {
          try {
            const chatId = json.id ?? nanoid()
            const title = json.messages[0].content.substring(0, 100)
            const createdAt = Date.now()
            const path = `/chat/${chatId}`

            // Structure the payload according to the database schema
            const chatData = {
              id: chatId,
              user_id: userId,
              payload: {
                title,
                createdAt,
                path,
                messages: [
                  ...messages,
                  {
                    content: completion,
                    role: 'assistant'
                  }
                ]
              }
            }

            // Insert chat into database using the correct structure
            await supabase
              .from('chats')
              .upsert(chatData)
              .throwOnError()

            console.log('Chat API: Successfully saved chat to database')
          } catch (error) {
            console.error('Chat API: Error saving chat to database:', error)
          }
        }
      })

      console.log('Chat API: Successfully created response stream')
      return new StreamingTextResponse(stream)
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
