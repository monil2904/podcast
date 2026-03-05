require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
async function test() {
    const { data, error } = await supabase.from('sessions').select('*').limit(1);
    if (error) console.error('Error:', error.message);
    else console.log('Success! Connection works.');
}
test();
