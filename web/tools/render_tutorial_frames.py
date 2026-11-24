"""Draw the source frames for Lingua Books' short, captioned public tutorials."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import shutil

ROOT = Path(__file__).resolve().parents[1]
FRAME_ROOT = Path(__file__).resolve().parent / '.tutorial-frames'
TOOLS = Path(__file__).resolve().parent
if FRAME_ROOT.resolve().parent != TOOLS.resolve():
    raise RuntimeError('The frame folder must stay inside web/tools.')

LESSONS = [
 ('upload','Upload a book',[
  ('From the library, choose Add a book.','Add a book',['My books','Public library','Add a book','Translator','Import old app']),
  ('Choose PDF, Word, text, or photos of pages.','Choose a file',['Drop a PDF, Word file, or page photos','Choose a file','Book title']),
  ('Set the title, main language, and any second language.','Set languages',['Book title: American English File','Main language: English','Second language: None','Pinyin: None']),
  ('Add the book, follow progress, then choose public or private.','Finish and share',['Add the book','Import step progress','Visibility: Private','Visibility: Public']),
 ]),
 ('navigate','Open a book and navigate',[
  ('Open a title from My books or the Public library.','Open a book',['Public library','My books','American English File · Student Book']),
  ('Use page arrows, the page number, or thumbnails to move.','Navigate pages',['Previous page','12 / 169','Next page','Page thumbnails']),
  ('Zoom with plus and minus, and drag the sidebar divider.','Set your view',['−','100%','+','Page panel  ↔  Sidebar']),
  ('Maximize the layout editor for focused work, then restore it.','Maximize and restore',['Open Page Layout','Maximize','Restore layout']),
 ]),
 ('voice','Choose a language and voice',[
  ('Open Voice settings from the sliders button.','Open voice settings',['Text','Script','Search','My audio','Voice settings  ☷']),
  ('Choose English, Chinese, or both for a bilingual page.','Choose what to read',['Read: English only','Read: Chinese only','Read: English and Chinese']),
  ('Pick each voice and press Test voice before reading.','Select and test',['English voice: US English','Chinese voice: Mandarin','Test voice  ▶']),
  ('Set speed and pauses; the label shows offline or online availability.','Adjust playback',['Voice speed','Pause between sentences','Offline on this page','Online voice']),
 ]),
 ('layout','Open and understand Page Layout',[
  ('Open Page Layout from the reader toolbar.','Open Page Layout',['Reader toolbar','Open full page-layout stage','Page Layout']),
  ('Saved boxes appear when the page has already been processed.','See saved work',['Page 12 · saved layout','Box 1 · heading','Box 2 · paragraph','Box 3 · exercise']),
  ('Use top navigation or thumbnails to choose another page.','Move around the book',['Previous','Page 12','Next','Bottom page thumbnails']),
  ('Numbered boxes show reading order; toggle Boxes to hide outlines.','Read the page map',['Boxes  ☑','1 · Heading','2 · Paragraph','3 · Exercise']),
 ]),
 ('reread','Reread a missing or unclear area',[
  ('Choose Read, then Read a specific area.','Choose a region',['Read','Read this page again','Read a specific area']),
  ('Drag around the words that are missing or unclear.','Mark the page',['Page text','Drag a rectangle over the missing lines']),
  ('Review the recognized text and correct it if needed.','Review OCR',['Recognized text','Edit wording','Check the selected area']),
  ('Reread selected area to replace its text; use Undo to retry.','Reread in place',['Reread selected area','Text is updated in this area','Undo']),
 ]),
 ('order','Set the reading order',[
  ('Open Order and choose Order by areas.','Order by areas',['Read','Order','Merge','Order by areas']),
  ('Draw a box around each paragraph in the sequence you want.','Draw in sequence',['Paragraph A','Paragraph B','Paragraph C','Boxes  1 → 2 → 3']),
  ('Or choose Reference order, then click the starting area and the next areas.','Choose a reference',['Reference order','1 · choose start','2 · click next','3 · click next']),
  ('Check number badges, adjust boxes, then save the page.','Check and save',['Reading order preview','Move or resize a box','Save boxes and process book']),
 ]),
 ('merge','Merge boxes or selected sentences',[
  ('Open Merge to combine page areas or sentence text.','Choose what to merge',['Merge','Merge areas','Merge selected sentences']),
  ('For areas, choose Merge in chosen order and click the boxes.','Merge areas',['Merge in chosen order','Area 1','Area 2','Finish merge']),
  ('For text, select sentences in sequence and choose Merge selected.','Merge sentences',['☑ Sentence 1 · first','☑ Sentence 2 · next','☑ Sentence 3 · next','Merge selected']),
  ('The selected order sets the new text order; Undo reverses the merge.','Review the result',['Combined text in selected order','Undo']),
 ]),
 ('text-picture','Correct text and replace a picture',[
  ('Open Text to review the words recognized from the page.','Review page text',['Read','Order','Merge','Pictures','Text']),
  ('Double-click a sentence to edit it, or choose Split sentence.','Edit or split',['Double-click to edit','Edit sentence text','Split sentence']),
  ('Open Pictures and select the picture area to replace.','Choose a picture',['Pictures','Select image area','Choose replacement']),
  ('Review the page layout and save when the changes look right.','Review and save',['Updated text','Replacement picture','Save boxes and process book']),
 ]),
 ('audio','Listen and manage saved audio',[
  ('Play this page aloud to hear it in your selected reading voice.','Read aloud',['Voice: US English','Play this page aloud  ▶']),
  ('The active sentence is highlighted while the page is read.','Follow along',['Sentence 1','Sentence 2 · now reading','Sentence 3']),
  ('Open My audio, select a saved recording, then press Play.','Play a recording',['My audio','Saved recording A','Saved recording B','Play  ▶']),
  ('Choose New audio for a separate recording from selected sentences.','Make new audio',['New audio','Select sentences','Choose voice','Create audio']),
 ]),
 ('sharing','Make a book public or private',[
  ('In My books, open the book menu.','Open book settings',['My books','American English File','Book menu  ⋮']),
  ('Choose Settings and sharing.','Choose visibility',['Open','Rename','Settings and sharing']),
  ('Private keeps it in your own library; Public lists it for other users.','Set access',['Private · only me','Public · visible in Public library']),
  ('Confirm the change. You can update visibility from the same menu later.','Change it later',['Save visibility','Public library','Book menu  ⋮']),
 ]),
]

W,H=1280,720
FONT_DIR=Path(r'C:\Windows\Fonts')
FONT_REG=FONT_DIR/'segoeui.ttf'
FONT_BOLD=FONT_DIR/'segoeuib.ttf'
FONT_LIGHT=FONT_DIR/'segoeuil.ttf'
def font(size,bold=False):
    p=FONT_BOLD if bold and FONT_BOLD.exists() else FONT_REG
    if not p.exists(): p=FONT_LIGHT
    return ImageFont.truetype(str(p),size) if p.exists() else ImageFont.load_default()
def round_rect(d,box,r,fill,outline=None,width=1):
    d.rounded_rectangle(box,radius=r,fill=fill,outline=outline,width=width)
def fit_lines(d,s,f,maxw):
    out=[]; row=''
    for word in s.split():
        test=(row+' '+word).strip()
        if d.textbbox((0,0),test,font=f)[2] > maxw and row:
            out.append(row); row=word
        else: row=test
    if row: out.append(row)
    return out
def draw_text(d,s,xy,f,fill,maxw=None,leading=5):
    x,y=xy
    for row in (fit_lines(d,s,f,maxw) if maxw else [s]):
        d.text((x,y),row,font=f,fill=fill)
        y+=d.textbbox((0,0),row,font=f)[3]+leading
    return y
def render(lesson,scene,frame_idx,frames_per_scene,filename):
    image=Image.new('RGB',(W,H),(20,23,29));d=ImageDraw.Draw(image)
    # App header
    d.rectangle((0,0,W,58),fill=(32,36,44));round_rect(d,(30,13,68,45),9,(255,83,105));d.text((38,19),'LB',font=font(16,True),fill=(25,27,32));d.text((80,16),'Lingua Books',font=font(19,True),fill=(244,246,249));d.text((300,19),'American English File · Student Book',font=font(15,True),fill=(187,197,211));round_rect(d,(1010,15,1242,43),7,(42,48,58));d.text((1030,21),'12 / 169    ‹     ›',font=font(14,True),fill=(210,218,229))
    # Sample page
    round_rect(d,(28,78,718,556),12,(248,246,237),(73,81,96));d.text((65,103),'1B   MODERN FAMILIES',font=font(23,True),fill=(34,114,95));d.rectangle((65,137,675,141),fill=(66,173,131));d.text((68,157),'VOCABULARY & SPEAKING',font=font(16,True),fill=(38,53,74));d.text((320,157),'family',font=font(15),fill=(96,124,89))
    left=['Talk to a partner. What is the difference between…?','a father and a parent','a mother and a stepmother','Read the article and answer the questions.','The modern family is changing in many ways.','People spend time together and share ideas.','What do you think about family life?']
    right=['Read the questions and discuss your ideas.','How often do you spend time together?','Talk about the people in your family.','Listen and follow the conversation.','Families are different in every country.','Share your answer with a partner.']
    for x,lines in [(70,left),(380,right)]:
        y=196
        for idx,s in enumerate(lines):
            is_box=(idx in (0,3,5))
            if is_box:round_rect(d,(x-7,y-5, x+270,y+30),5,(226,238,249),(81,132,232),2)
            draw_text(d,s,(x,y),font(13), (49,57,69),maxw=255,leading=2);y+=51 if idx in (0,3,5) else 38
    round_rect(d,(62,438,675,521),8,(229,240,223),(177,209,162));d.text((78,452),'READING PRACTICE',font=font(14,True),fill=(80,120,75));draw_text(d,'Listen, follow the text, and practise the new language.',(78,477),font(15),(69,85,74),565)
    # Right-side control panel
    round_rect(d,(742,78,1252,556),12,(32,36,44),(57,65,77));d.text((770,95),lesson[1].upper(),font=font(14,True),fill=(143,218,210));draw_text(d,lesson[2][scene][1],(770,119),font(24,True),(243,245,248),450,4);d.rectangle((770,173,1220,175),fill=(57,65,77))
    items=lesson[2][scene][2]
    start_y=192;row_gap=min(51,326//max(1,len(items)))
    positions=[]
    for i,item in enumerate(items):
        y=start_y+i*row_gap;focus=(i==min(scene,len(items)-1));color=(45,55,80) if focus else (39,44,53);edge=(76,128,255) if focus else (54,61,73)
        round_rect(d,(766,y,1225,y+39),7,color,edge,2 if focus else 1);round_rect(d,(779,y+11,795,y+27),4,(75,129,255) if focus else (72,82,98));d.text((808,y+9),item,font=font(15,focus),fill=(255,255,255) if focus else (211,218,228));positions.append((840,y+20))
    # Cue card with the exact action and its explanatory caption
    round_rect(d,(746,570,1252,686),10,(18,22,29),(52,64,77));d.text((766,584),'LINGUA BOOKS · QUICK GUIDE',font=font(12,True),fill=(127,216,208));draw_text(d,lesson[2][scene][0],(766,610),font(18,True),(241,243,247),460,5)
    # Animated pointer travels to and clicks the highlighted control.
    target=positions[min(scene,len(positions)-1)];t=frame_idx/frames_per_scene;ease=min(1,max(0,t/0.3));ease=ease*ease*(3-2*ease);sx,sy=(680,500);px=sx+(target[0]-sx)*ease;py=sy+(target[1]-sy)*ease
    pulse=1 if t>0.27 and (int(t*16)%2==0) else 0;d.ellipse((target[0]-16-pulse*4,target[1]-16-pulse*4,target[0]+16+pulse*4,target[1]+16+pulse*4),outline=(255,191,72),width=3)
    d.polygon([(px,py),(px+2,py+24),(px+8,py+17),(px+14,py+30),(px+20,py+27),(px+14,py+14),(px+24,py+14)],fill=(255,255,255),outline=(26,31,38))
    # Timeline stays clear even in the last frame.
    overall=(scene+t)/len(lesson[2]);d.rectangle((30,700,1250,705),fill=(51,59,72));d.rectangle((30,700,30+int(1220*overall),705),fill=(21,185,168))
    image.save(filename,'JPEG',quality=88,optimize=True)
    return image

def main():
    if FRAME_ROOT.exists():shutil.rmtree(FRAME_ROOT)
    FRAME_ROOT.mkdir(parents=True)
    for lesson in LESSONS:
        folder=FRAME_ROOT/lesson[0];folder.mkdir()
        first=None
        frames_per_scene=60  # 6 seconds at 10 fps; four captioned steps per clip.
        for scene in range(len(lesson[2])):
            for frame in range(frames_per_scene):
                p=folder/f'{scene*frames_per_scene+frame:04d}.jpg'
                image=render(lesson,scene,frame,frames_per_scene,p)
                if first is None:first=image.copy()
        first.save(ROOT/'tutorials'/f'{lesson[0]}.jpg','JPEG',quality=88,optimize=True)
        print(f'{lesson[0]}: 24 seconds · {frames_per_scene*len(lesson[2])} frames')
    print(FRAME_ROOT)

if __name__=='__main__':main()
